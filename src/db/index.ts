/**
 * Trade Database
 *
 * SQLite-based storage for trade history, snapshots, and impact tracking.
 * Designed for fast inserts, cheap rollups, and async impact computation.
 */

import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';

// Types
export interface RawTrade {
  trade_id: string;
  venue: 'polymarket' | 'kalshi';
  market_id: string;
  trader_id: string;
  side: 'BUY' | 'SELL';
  outcome: 'YES' | 'NO';
  price_cents: number;       // Integer cents (0-100)
  size: number;              // Shares
  notional_cents: number;    // price * size
  mid_at_trade_cents: number; // Reference price for impact calc
  ts: number;                // Unix ms
}

export interface MarketSnapshot {
  market_id: string;
  minute_ts: number;         // Floor to minute
  mid_cents: number;
  bid_cents: number;
  ask_cents: number;
  spread_cents: number;
  vol_cents_1m: number;
  net_flow_cents_1m: number; // buy - sell notional
}

export interface TradeImpact {
  trade_id: string;
  mid_1m_cents: number | null;
  mid_5m_cents: number | null;
  mid_15m_cents: number | null;
  dmid_1m: number | null;    // Delta from trade-time mid
  dmid_5m: number | null;
  dmid_15m: number | null;
  impact_score: number | null;
  computed_ts: number;
}

export interface TraderStatsDaily {
  trader_id: string;
  date: string;              // YYYY-MM-DD
  trade_count: number;
  notional_cents: number;
  behavior_counts: Record<string, number>;
  avg_impact_score: number | null;
  early_score: number | null;
  follow_through_score: number | null;
  fade_score: number | null;
}

export interface ImpactJob {
  id?: number;
  trade_id: string;
  horizon_minutes: number;   // 1, 5, or 15
  run_at_ts: number;
  status: 'pending' | 'done' | 'failed';
  tries: number;
}

// Constants
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export class TradeDatabase {
  private db: Database.Database;
  private insertTradeStmt!: Database.Statement;
  private insertSnapshotStmt!: Database.Statement;
  private insertImpactJobStmt!: Database.Statement;
  private upsertImpactStmt!: Database.Statement;
  private getSnapshotStmt!: Database.Statement;
  private getPendingJobsStmt!: Database.Statement;
  private markJobDoneStmt!: Database.Statement;
  private markJobFailedStmt!: Database.Statement;

  constructor(dbPath?: string) {
    // Default to data/trades.db in project root
    if (!dbPath) {
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const dataDir = join(__dirname, '..', '..', 'data');
      if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
      }
      dbPath = join(dataDir, 'trades.db');
    }

    this.db = new Database(dbPath);
    this.initPragmas();
    this.initSchema();
    this.prepareStatements();

    console.log(`[TradeDB] Initialized at ${dbPath}`);
  }

  private initPragmas(): void {
    // WAL mode for fast writes + concurrent reads
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('cache_size = -20000'); // 20MB cache
    this.db.pragma('busy_timeout = 5000');
  }

  private initSchema(): void {
    // Raw trades - append only, immutable
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS raw_trades (
        trade_id TEXT PRIMARY KEY,
        venue TEXT NOT NULL,
        market_id TEXT NOT NULL,
        trader_id TEXT NOT NULL,
        side TEXT NOT NULL,
        outcome TEXT NOT NULL,
        price_cents INTEGER NOT NULL,
        size INTEGER NOT NULL,
        notional_cents INTEGER NOT NULL,
        mid_at_trade_cents INTEGER NOT NULL,
        ts INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_trades_market_ts ON raw_trades(market_id, ts);
      CREATE INDEX IF NOT EXISTS idx_trades_trader_ts ON raw_trades(trader_id, ts);
      CREATE INDEX IF NOT EXISTS idx_trades_ts ON raw_trades(ts);
    `);

    // Market snapshots - 1 minute candles
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS market_snapshots_1m (
        market_id TEXT NOT NULL,
        minute_ts INTEGER NOT NULL,
        mid_cents INTEGER NOT NULL,
        bid_cents INTEGER,
        ask_cents INTEGER,
        spread_cents INTEGER,
        vol_cents_1m INTEGER DEFAULT 0,
        net_flow_cents_1m INTEGER DEFAULT 0,
        PRIMARY KEY (market_id, minute_ts)
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON market_snapshots_1m(minute_ts);
    `);

    // Trade impact - computed async
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trade_impact (
        trade_id TEXT PRIMARY KEY,
        mid_1m_cents INTEGER,
        mid_5m_cents INTEGER,
        mid_15m_cents INTEGER,
        dmid_1m INTEGER,
        dmid_5m INTEGER,
        dmid_15m INTEGER,
        impact_score REAL,
        computed_ts INTEGER NOT NULL
      );
    `);

    // Impact jobs queue
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS impact_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_id TEXT NOT NULL,
        horizon_minutes INTEGER NOT NULL,
        run_at_ts INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',
        tries INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_pending ON impact_jobs(status, run_at_ts)
        WHERE status = 'pending';
    `);

    // Trader stats daily rollup
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trader_stats_daily (
        trader_id TEXT NOT NULL,
        date TEXT NOT NULL,
        trade_count INTEGER DEFAULT 0,
        notional_cents INTEGER DEFAULT 0,
        behavior_counts TEXT DEFAULT '{}',
        avg_impact_score REAL,
        early_score REAL,
        follow_through_score REAL,
        fade_score REAL,
        PRIMARY KEY (trader_id, date)
      );
    `);

    // Market quality hourly
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS market_quality_hourly (
        market_id TEXT NOT NULL,
        hour_ts INTEGER NOT NULL,
        spread_avg REAL,
        top_trader_pct REAL,
        arb_frequency REAL,
        quality_tier TEXT,
        PRIMARY KEY (market_id, hour_ts)
      );
    `);
  }

  private prepareStatements(): void {
    this.insertTradeStmt = this.db.prepare(`
      INSERT OR IGNORE INTO raw_trades
      (trade_id, venue, market_id, trader_id, side, outcome, price_cents, size, notional_cents, mid_at_trade_cents, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.insertSnapshotStmt = this.db.prepare(`
      INSERT INTO market_snapshots_1m
      (market_id, minute_ts, mid_cents, bid_cents, ask_cents, spread_cents, vol_cents_1m, net_flow_cents_1m)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(market_id, minute_ts) DO UPDATE SET
        mid_cents = excluded.mid_cents,
        bid_cents = excluded.bid_cents,
        ask_cents = excluded.ask_cents,
        spread_cents = excluded.spread_cents,
        vol_cents_1m = vol_cents_1m + excluded.vol_cents_1m,
        net_flow_cents_1m = net_flow_cents_1m + excluded.net_flow_cents_1m
    `);

    this.insertImpactJobStmt = this.db.prepare(`
      INSERT INTO impact_jobs (trade_id, horizon_minutes, run_at_ts, status, tries)
      VALUES (?, ?, ?, 'pending', 0)
    `);

    this.upsertImpactStmt = this.db.prepare(`
      INSERT INTO trade_impact (trade_id, mid_1m_cents, mid_5m_cents, mid_15m_cents, dmid_1m, dmid_5m, dmid_15m, impact_score, computed_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(trade_id) DO UPDATE SET
        mid_1m_cents = COALESCE(excluded.mid_1m_cents, mid_1m_cents),
        mid_5m_cents = COALESCE(excluded.mid_5m_cents, mid_5m_cents),
        mid_15m_cents = COALESCE(excluded.mid_15m_cents, mid_15m_cents),
        dmid_1m = COALESCE(excluded.dmid_1m, dmid_1m),
        dmid_5m = COALESCE(excluded.dmid_5m, dmid_5m),
        dmid_15m = COALESCE(excluded.dmid_15m, dmid_15m),
        impact_score = COALESCE(excluded.impact_score, impact_score),
        computed_ts = excluded.computed_ts
    `);

    this.getSnapshotStmt = this.db.prepare(`
      SELECT * FROM market_snapshots_1m
      WHERE market_id = ? AND minute_ts = ?
    `);

    this.getPendingJobsStmt = this.db.prepare(`
      SELECT * FROM impact_jobs
      WHERE status = 'pending' AND run_at_ts <= ?
      LIMIT 100
    `);

    this.markJobDoneStmt = this.db.prepare(`
      UPDATE impact_jobs SET status = 'done' WHERE id = ?
    `);

    this.markJobFailedStmt = this.db.prepare(`
      UPDATE impact_jobs SET status = 'failed', tries = tries + 1 WHERE id = ?
    `);
  }

  // ============================================
  // Trade Operations
  // ============================================

  /**
   * Insert a trade and queue impact jobs
   */
  insertTrade(trade: RawTrade): void {
    // Insert raw trade
    this.insertTradeStmt.run(
      trade.trade_id,
      trade.venue,
      trade.market_id,
      trade.trader_id,
      trade.side,
      trade.outcome,
      trade.price_cents,
      trade.size,
      trade.notional_cents,
      trade.mid_at_trade_cents,
      trade.ts
    );

    // Queue impact jobs for 1m, 5m, 15m
    const horizons = [1, 5, 15];
    for (const h of horizons) {
      this.insertImpactJobStmt.run(
        trade.trade_id,
        h,
        trade.ts + h * MINUTE_MS
      );
    }
  }

  /**
   * Batch insert trades (faster for bulk operations)
   */
  insertTrades(trades: RawTrade[]): void {
    const insertMany = this.db.transaction((trades: RawTrade[]) => {
      for (const trade of trades) {
        this.insertTrade(trade);
      }
    });
    insertMany(trades);
  }

  /**
   * Get trades for a market in time range
   */
  getTradesByMarket(marketId: string, startTs?: number, endTs?: number, limit = 1000): RawTrade[] {
    let sql = 'SELECT * FROM raw_trades WHERE market_id = ?';
    const params: (string | number)[] = [marketId];

    if (startTs) {
      sql += ' AND ts >= ?';
      params.push(startTs);
    }
    if (endTs) {
      sql += ' AND ts <= ?';
      params.push(endTs);
    }

    sql += ' ORDER BY ts DESC LIMIT ?';
    params.push(limit);

    return this.db.prepare(sql).all(...params) as RawTrade[];
  }

  /**
   * Get trades for a trader in time range
   */
  getTradesByTrader(traderId: string, startTs?: number, endTs?: number, limit = 1000): RawTrade[] {
    let sql = 'SELECT * FROM raw_trades WHERE trader_id = ?';
    const params: (string | number)[] = [traderId];

    if (startTs) {
      sql += ' AND ts >= ?';
      params.push(startTs);
    }
    if (endTs) {
      sql += ' AND ts <= ?';
      params.push(endTs);
    }

    sql += ' ORDER BY ts DESC LIMIT ?';
    params.push(limit);

    return this.db.prepare(sql).all(...params) as RawTrade[];
  }

  // ============================================
  // Snapshot Operations
  // ============================================

  /**
   * Upsert a market snapshot (accumulates volume/flow)
   */
  upsertSnapshot(snapshot: MarketSnapshot): void {
    this.insertSnapshotStmt.run(
      snapshot.market_id,
      snapshot.minute_ts,
      snapshot.mid_cents,
      snapshot.bid_cents,
      snapshot.ask_cents,
      snapshot.spread_cents,
      snapshot.vol_cents_1m,
      snapshot.net_flow_cents_1m
    );
  }

  /**
   * Get snapshot for a market at a specific minute
   */
  getSnapshot(marketId: string, minuteTs: number): MarketSnapshot | undefined {
    return this.getSnapshotStmt.get(marketId, minuteTs) as MarketSnapshot | undefined;
  }

  /**
   * Get snapshots for a market in time range
   */
  getSnapshots(marketId: string, startTs: number, endTs: number): MarketSnapshot[] {
    return this.db.prepare(`
      SELECT * FROM market_snapshots_1m
      WHERE market_id = ? AND minute_ts >= ? AND minute_ts <= ?
      ORDER BY minute_ts ASC
    `).all(marketId, startTs, endTs) as MarketSnapshot[];
  }

  // ============================================
  // Impact Operations
  // ============================================

  /**
   * Get pending impact jobs that are due
   */
  getPendingJobs(now: number = Date.now()): ImpactJob[] {
    return this.getPendingJobsStmt.all(now) as ImpactJob[];
  }

  /**
   * Process a single impact job
   */
  processImpactJob(job: ImpactJob): boolean {
    // Get the original trade
    const trade = this.db.prepare('SELECT * FROM raw_trades WHERE trade_id = ?')
      .get(job.trade_id) as RawTrade | undefined;

    if (!trade) {
      this.markJobFailedStmt.run(job.id);
      return false;
    }

    // Calculate the target minute timestamp
    const targetMinute = Math.floor((trade.ts + job.horizon_minutes * MINUTE_MS) / MINUTE_MS) * MINUTE_MS;

    // Get snapshot at target time
    const snapshot = this.getSnapshot(trade.market_id, targetMinute);

    if (!snapshot) {
      // Snapshot not available yet, retry later (up to 3 tries)
      const jobRow = this.db.prepare('SELECT tries FROM impact_jobs WHERE id = ?').get(job.id) as { tries: number };
      if (jobRow && jobRow.tries >= 3) {
        this.markJobFailedStmt.run(job.id);
      }
      // Leave as pending for retry
      return false;
    }

    // Calculate delta from trade-time mid
    const delta = snapshot.mid_cents - trade.mid_at_trade_cents;

    // Get existing impact record or create new
    const existing = this.db.prepare('SELECT * FROM trade_impact WHERE trade_id = ?')
      .get(trade.trade_id) as TradeImpact | undefined;

    // Prepare values based on horizon
    let mid_1m = existing?.mid_1m_cents ?? null;
    let mid_5m = existing?.mid_5m_cents ?? null;
    let mid_15m = existing?.mid_15m_cents ?? null;
    let dmid_1m = existing?.dmid_1m ?? null;
    let dmid_5m = existing?.dmid_5m ?? null;
    let dmid_15m = existing?.dmid_15m ?? null;

    if (job.horizon_minutes === 1) {
      mid_1m = snapshot.mid_cents;
      dmid_1m = delta;
    } else if (job.horizon_minutes === 5) {
      mid_5m = snapshot.mid_cents;
      dmid_5m = delta;
    } else if (job.horizon_minutes === 15) {
      mid_15m = snapshot.mid_cents;
      dmid_15m = delta;
    }

    // Calculate impact score (use 5m delta, normalized by trade size)
    // Impact = |delta| / sqrt(notional) - larger trades expected to move more
    let impactScore: number | null = null;
    if (dmid_5m !== null && trade.notional_cents > 0) {
      impactScore = Math.abs(dmid_5m) / Math.sqrt(trade.notional_cents / 100);
    }

    // Upsert impact record
    this.upsertImpactStmt.run(
      trade.trade_id,
      mid_1m,
      mid_5m,
      mid_15m,
      dmid_1m,
      dmid_5m,
      dmid_15m,
      impactScore,
      Date.now()
    );

    // Mark job done
    this.markJobDoneStmt.run(job.id);
    return true;
  }

  /**
   * Process all pending impact jobs
   */
  processPendingJobs(): number {
    const jobs = this.getPendingJobs();
    let processed = 0;
    for (const job of jobs) {
      if (this.processImpactJob(job)) {
        processed++;
      }
    }
    return processed;
  }

  /**
   * Get impact data for a trade
   */
  getTradeImpact(tradeId: string): TradeImpact | undefined {
    return this.db.prepare('SELECT * FROM trade_impact WHERE trade_id = ?')
      .get(tradeId) as TradeImpact | undefined;
  }

  /**
   * Get impact badge for a trade
   */
  getImpactBadge(tradeId: string): 'MOVED_MARKET' | 'NO_IMPACT' | null {
    const impact = this.getTradeImpact(tradeId);
    if (!impact || impact.dmid_5m === null) return null;

    const absDelta = Math.abs(impact.dmid_5m);
    if (absDelta >= 3) return 'MOVED_MARKET';  // 3+ cents
    if (absDelta <= 1) return 'NO_IMPACT';      // 1 cent or less
    return null;
  }

  /**
   * Look up impact badge by trade properties (for API queries)
   * Finds the closest trade within ±5 seconds of the given timestamp
   */
  getImpactBadgeByProps(
    traderId: string,
    marketId: string,
    timestamp: number
  ): 'MOVED_MARKET' | 'NO_IMPACT' | null {
    // Find trade_id by matching properties (±5 second window for timestamp)
    const trade = this.db.prepare(`
      SELECT trade_id FROM raw_trades
      WHERE trader_id = ? AND market_id = ? AND ts BETWEEN ? AND ?
      ORDER BY ABS(ts - ?) ASC
      LIMIT 1
    `).get(
      traderId.toLowerCase(),
      marketId,
      timestamp - 5000,
      timestamp + 5000,
      timestamp
    ) as { trade_id: string } | undefined;

    if (!trade) return null;
    return this.getImpactBadge(trade.trade_id);
  }

  // ============================================
  // Aggregation Operations
  // ============================================

  /**
   * Get net flow for a market in last N minutes
   */
  getMarketNetFlow(marketId: string, minutes: number): { netFlow: number; volume: number } {
    const cutoff = Math.floor((Date.now() - minutes * MINUTE_MS) / MINUTE_MS) * MINUTE_MS;
    const result = this.db.prepare(`
      SELECT
        COALESCE(SUM(net_flow_cents_1m), 0) as netFlow,
        COALESCE(SUM(vol_cents_1m), 0) as volume
      FROM market_snapshots_1m
      WHERE market_id = ? AND minute_ts >= ?
    `).get(marketId, cutoff) as { netFlow: number; volume: number };
    return result;
  }

  /**
   * Get trader stats for impact scoring
   */
  getTraderImpactStats(traderId: string, days: number = 7): {
    avgImpact: number | null;
    earlyScore: number | null;
    followThrough: number | null;
    tradeCount: number;
  } {
    const cutoff = Date.now() - days * DAY_MS;

    const result = this.db.prepare(`
      SELECT
        AVG(ti.impact_score) as avgImpact,
        AVG(CASE WHEN ti.dmid_5m > 0 AND rt.side = 'BUY' THEN 1
                 WHEN ti.dmid_5m < 0 AND rt.side = 'SELL' THEN 1
                 ELSE 0 END) as earlyScore,
        AVG(CASE WHEN ABS(ti.dmid_15m) > ABS(ti.dmid_5m) THEN 1 ELSE 0 END) as followThrough,
        COUNT(*) as tradeCount
      FROM raw_trades rt
      LEFT JOIN trade_impact ti ON rt.trade_id = ti.trade_id
      WHERE rt.trader_id = ? AND rt.ts >= ?
    `).get(traderId, cutoff) as {
      avgImpact: number | null;
      earlyScore: number | null;
      followThrough: number | null;
      tradeCount: number;
    };

    return result;
  }

  // ============================================
  // Retention / Cleanup
  // ============================================

  /**
   * Prune old data based on retention policy
   */
  prune(rawTradeDays = 30, snapshotDays = 7): { trades: number; snapshots: number; jobs: number } {
    const tradeCutoff = Date.now() - rawTradeDays * DAY_MS;
    const snapshotCutoff = Date.now() - snapshotDays * DAY_MS;

    const tradeResult = this.db.prepare('DELETE FROM raw_trades WHERE ts < ?').run(tradeCutoff);
    const snapshotResult = this.db.prepare('DELETE FROM market_snapshots_1m WHERE minute_ts < ?').run(snapshotCutoff);
    const jobResult = this.db.prepare("DELETE FROM impact_jobs WHERE status IN ('done', 'failed')").run();

    // Also clean up orphaned impact records
    this.db.exec(`
      DELETE FROM trade_impact
      WHERE trade_id NOT IN (SELECT trade_id FROM raw_trades)
    `);

    return {
      trades: tradeResult.changes,
      snapshots: snapshotResult.changes,
      jobs: jobResult.changes,
    };
  }

  /**
   * Get trades with pagination (for scalable loading)
   */
  getTrades(options: {
    limit?: number;
    offset?: number;
    traderId?: string;
    marketId?: string;
  } = {}): {
    trades: RawTrade[];
    total: number;
    hasMore: boolean;
  } {
    const { limit = 50, offset = 0, traderId, marketId } = options;

    // Build WHERE clause
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (traderId) {
      conditions.push('trader_id = ?');
      params.push(traderId.toLowerCase());
    }
    if (marketId) {
      conditions.push('market_id = ?');
      params.push(marketId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countResult = this.db.prepare(
      `SELECT COUNT(*) as c FROM raw_trades ${whereClause}`
    ).get(...params) as { c: number };
    const total = countResult.c;

    // Get paginated trades
    const trades = this.db.prepare(`
      SELECT * FROM raw_trades
      ${whereClause}
      ORDER BY ts DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as RawTrade[];

    return {
      trades,
      total,
      hasMore: offset + trades.length < total,
    };
  }

  /**
   * Get database stats
   */
  getStats(): {
    trades: number;
    snapshots: number;
    impacts: number;
    pendingJobs: number;
    oldestTrade: number | null;
  } {
    const trades = (this.db.prepare('SELECT COUNT(*) as c FROM raw_trades').get() as { c: number }).c;
    const snapshots = (this.db.prepare('SELECT COUNT(*) as c FROM market_snapshots_1m').get() as { c: number }).c;
    const impacts = (this.db.prepare('SELECT COUNT(*) as c FROM trade_impact').get() as { c: number }).c;
    const pendingJobs = (this.db.prepare("SELECT COUNT(*) as c FROM impact_jobs WHERE status = 'pending'").get() as { c: number }).c;
    const oldest = this.db.prepare('SELECT MIN(ts) as ts FROM raw_trades').get() as { ts: number | null };

    return {
      trades,
      snapshots,
      impacts,
      pendingJobs,
      oldestTrade: oldest.ts,
    };
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}

// Singleton instance
let dbInstance: TradeDatabase | null = null;

export function getTradeDatabase(): TradeDatabase {
  if (!dbInstance) {
    dbInstance = new TradeDatabase();
  }
  return dbInstance;
}

export function closeTradeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

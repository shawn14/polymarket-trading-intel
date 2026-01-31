/**
 * Impact Worker
 *
 * Periodic worker that:
 * 1. Processes pending impact jobs (computes price deltas after 1m/5m/15m)
 * 2. Generates market snapshots every minute
 * 3. Runs retention cleanup daily
 */

import { EventEmitter } from 'events';
import { getTradeDatabase, type TradeDatabase, type MarketSnapshot } from './index.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export interface ImpactWorkerEvents {
  jobsProcessed: [count: number];
  snapshotsGenerated: [count: number];
  pruned: [stats: { trades: number; snapshots: number; jobs: number }];
  error: [error: Error];
}

export interface MarketPriceSource {
  getMarketMid(marketId: string): number | undefined;
  getMarketBid(marketId: string): number | undefined;
  getMarketAsk(marketId: string): number | undefined;
  getActiveMarkets(): string[];
}

export class ImpactWorker extends EventEmitter<ImpactWorkerEvents> {
  private db: TradeDatabase;
  private priceSource: MarketPriceSource;
  private jobInterval: NodeJS.Timeout | null = null;
  private snapshotInterval: NodeJS.Timeout | null = null;
  private pruneInterval: NodeJS.Timeout | null = null;
  private running = false;

  constructor(priceSource: MarketPriceSource) {
    super();
    this.db = getTradeDatabase();
    this.priceSource = priceSource;
  }

  /**
   * Start the worker
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    console.log('[ImpactWorker] Starting...');

    // Process impact jobs every 5 seconds
    this.jobInterval = setInterval(() => {
      try {
        const processed = this.db.processPendingJobs();
        if (processed > 0) {
          this.emit('jobsProcessed', processed);
        }
      } catch (error) {
        this.emit('error', error as Error);
      }
    }, 5000);

    // Generate snapshots every minute
    this.snapshotInterval = setInterval(() => {
      try {
        const count = this.generateSnapshots();
        if (count > 0) {
          this.emit('snapshotsGenerated', count);
        }
      } catch (error) {
        this.emit('error', error as Error);
      }
    }, MINUTE_MS);

    // Run initial snapshot
    setTimeout(() => {
      try {
        this.generateSnapshots();
      } catch (error) {
        this.emit('error', error as Error);
      }
    }, 1000);

    // Prune old data every hour
    this.pruneInterval = setInterval(() => {
      try {
        const stats = this.db.prune();
        if (stats.trades > 0 || stats.snapshots > 0 || stats.jobs > 0) {
          console.log(`[ImpactWorker] Pruned: ${stats.trades} trades, ${stats.snapshots} snapshots, ${stats.jobs} jobs`);
          this.emit('pruned', stats);
        }
      } catch (error) {
        this.emit('error', error as Error);
      }
    }, HOUR_MS);

    console.log('[ImpactWorker] Started');
  }

  /**
   * Stop the worker
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.jobInterval) {
      clearInterval(this.jobInterval);
      this.jobInterval = null;
    }
    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval);
      this.snapshotInterval = null;
    }
    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = null;
    }

    console.log('[ImpactWorker] Stopped');
  }

  /**
   * Generate snapshots for all active markets
   */
  private generateSnapshots(): number {
    const markets = this.priceSource.getActiveMarkets();
    const minuteTs = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
    let count = 0;

    for (const marketId of markets) {
      const mid = this.priceSource.getMarketMid(marketId);
      if (mid === undefined) continue;

      const bid = this.priceSource.getMarketBid(marketId);
      const ask = this.priceSource.getMarketAsk(marketId);

      const snapshot: MarketSnapshot = {
        market_id: marketId,
        minute_ts: minuteTs,
        mid_cents: Math.round(mid * 100),
        bid_cents: bid !== undefined ? Math.round(bid * 100) : 0,
        ask_cents: ask !== undefined ? Math.round(ask * 100) : 0,
        spread_cents: bid !== undefined && ask !== undefined
          ? Math.round((ask - bid) * 100)
          : 0,
        vol_cents_1m: 0,  // Will be accumulated from trades
        net_flow_cents_1m: 0,  // Will be accumulated from trades
      };

      this.db.upsertSnapshot(snapshot);
      count++;
    }

    return count;
  }

  /**
   * Force process all pending jobs (for testing)
   */
  processNow(): number {
    return this.db.processPendingJobs();
  }

  /**
   * Get worker stats
   */
  getStats(): {
    running: boolean;
    dbStats: ReturnType<TradeDatabase['getStats']>;
  } {
    return {
      running: this.running,
      dbStats: this.db.getStats(),
    };
  }
}

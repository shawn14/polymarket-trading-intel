/**
 * Whale Tracker
 *
 * Main coordinator for whale intelligence system.
 * Listens to trade events, maintains whale universe, and emits whale trade events.
 */

import { EventEmitter } from 'events';
import type { PolymarketClient } from '../polymarket/client.js';
import type { Trade } from '../polymarket/types.js';
import type {
  WhaleInfo,
  WhaleTrade,
  StoredTrade,
  CachedWhaleTrade,
  WhaleEdgeSignal,
  MarketCategory,
  ExpertProfile,
} from './types.js';
import { TradeStore } from './trade-store.js';
import { WhaleUniverse } from './whale-universe.js';
import { PositionLedger } from './position-ledger.js';
import { WhaleActivityMonitor } from './activity-monitor.js';
import { ExpertTracker } from './expert-tracker.js';
import { fetchLeaderboard, getBootstrapWhales } from './leaderboard.js';

// Rebuild whale universe every hour
const REBUILD_INTERVAL_MS = 60 * 60 * 1000;

// Cleanup old cached whale trades every 10 minutes
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

// Max age for cached whale trades (4 hours)
const WHALE_TRADE_MAX_AGE_MS = 4 * 60 * 60 * 1000;

// Max cached whale trades
const MAX_CACHED_WHALE_TRADES = 1000;

export interface WhaleTrackerEvents {
  whaleTrade: [trade: WhaleTrade];
  universeRebuild: [whaleCount: number];
  error: [error: Error];
}

export interface WhaleTrackerDeps {
  polymarket: PolymarketClient;
}

export class WhaleTracker extends EventEmitter<WhaleTrackerEvents> {
  private deps: WhaleTrackerDeps;
  private tradeStore: TradeStore;
  private whaleUniverse: WhaleUniverse;
  private positionLedger: PositionLedger;
  private activityMonitor: WhaleActivityMonitor;
  private expertTracker: ExpertTracker;
  private cachedWhaleTrades: CachedWhaleTrade[] = [];

  private rebuildTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private tradeCounter = 0;

  // Market price cache for price snapshots
  private marketPrices: Map<string, number> = new Map();

  constructor(deps: WhaleTrackerDeps) {
    super();
    this.deps = deps;

    // Initialize components
    this.tradeStore = new TradeStore();
    this.whaleUniverse = new WhaleUniverse(this.tradeStore);
    this.positionLedger = new PositionLedger();
    this.activityMonitor = new WhaleActivityMonitor(this.whaleUniverse);
    this.expertTracker = new ExpertTracker();

    // Setup listeners
    this.setupTradeListener();
    this.setupPriceListener();
    this.setupActivityMonitor();
  }

  /**
   * Start the whale tracker
   */
  async start(): Promise<void> {
    console.log('[WhaleTracker] Starting...');

    // Bootstrap from leaderboard (optional)
    await this.bootstrapFromLeaderboard();

    // Initial rebuild
    await this.whaleUniverse.rebuild();

    // Start activity monitor (polls for whale trades)
    this.activityMonitor.start();

    // Start periodic rebuild
    this.rebuildTimer = setInterval(async () => {
      try {
        await this.whaleUniverse.rebuild();
        this.emit('universeRebuild', this.whaleUniverse.getAllWhales().length);
      } catch (error) {
        this.emit('error', error as Error);
      }
    }, REBUILD_INTERVAL_MS);

    // Start periodic cleanup
    this.cleanupTimer = setInterval(() => {
      this.cleanupCachedTrades();
      this.positionLedger.cleanup();
    }, CLEANUP_INTERVAL_MS);

    console.log('[WhaleTracker] Started');
  }

  /**
   * Stop the whale tracker
   */
  stop(): void {
    this.activityMonitor.stop();
    if (this.rebuildTimer) {
      clearInterval(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    console.log('[WhaleTracker] Stopped');
  }

  /**
   * Bootstrap from leaderboard
   * Seeds whale universe with top traders from Polymarket leaderboard
   */
  private async bootstrapFromLeaderboard(): Promise<void> {
    try {
      // Try to fetch leaderboard (top 200 traders for expert detection)
      let entries = await fetchLeaderboard(200);

      // If fetch fails, use known whales
      if (entries.length === 0) {
        entries = getBootstrapWhales();
      }

      if (entries.length > 0) {
        // Seed whale universe with leaderboard entries
        this.whaleUniverse.seedFromLeaderboard(entries);
        console.log(`[WhaleTracker] Bootstrapped with ${entries.length} leaderboard whales`);
      } else {
        console.log('[WhaleTracker] No leaderboard data, will build from trades');
      }
    } catch (error) {
      console.log('[WhaleTracker] Leaderboard bootstrap failed:', (error as Error).message);
    }
  }

  /**
   * Setup trade event listener
   */
  private setupTradeListener(): void {
    this.deps.polymarket.on('trade', (trade: Trade) => {
      this.handleTrade(trade);
    });
  }

  /**
   * Setup price listener for market price cache
   */
  private setupPriceListener(): void {
    this.deps.polymarket.on('price', (update) => {
      this.marketPrices.set(update.assetId, update.price);
    });

    this.deps.polymarket.on('book', (book) => {
      this.marketPrices.set(book.assetId, book.midpoint);
    });
  }

  /**
   * Setup activity monitor to poll for whale trades
   */
  private setupActivityMonitor(): void {
    this.activityMonitor.on('whaleTrade', (trade, activity) => {
      // Get current market price for snapshot
      const currentPrice = this.marketPrices.get(trade.assetId) ?? trade.price;

      // Cache the whale trade
      this.cacheWhaleTrade(trade, currentPrice);

      // Update position ledger
      this.positionLedger.onTrade({
        id: `activity-${Date.now()}`,
        marketId: trade.marketId,
        assetId: trade.assetId,
        maker: '',
        taker: trade.whale.address,
        side: trade.side,
        outcome: trade.outcome,
        price: trade.price,
        size: trade.size,
        sizeUsdc: trade.sizeUsdc,
        timestamp: trade.timestamp,
      }, trade.whale.address);

      // Track in expert tracker for category analysis
      this.expertTracker.recordTrade(trade);

      // Update last seen
      this.whaleUniverse.updateLastSeen(trade.whale.address);

      // Emit to listeners
      this.emit('whaleTrade', trade);
    });

    this.activityMonitor.on('error', (error) => {
      this.emit('error', error);
    });
  }

  /**
   * Handle incoming trade
   */
  private handleTrade(trade: Trade): void {
    this.tradeCounter++;

    // Convert to stored trade format
    // Note: CLOB doesn't give us maker/taker addresses directly
    // We use the asset ID to infer the trade direction
    const storedTrade: StoredTrade = {
      id: `${trade.assetId}-${trade.timestamp}-${this.tradeCounter}`,
      marketId: trade.market,
      assetId: trade.assetId,
      maker: '', // Not available from CLOB WebSocket
      taker: '', // Not available from CLOB WebSocket
      side: trade.side,
      outcome: 'YES', // Default - would need market metadata to determine
      price: trade.price,
      size: trade.size,
      sizeUsdc: trade.size * trade.price,
      timestamp: trade.timestamp,
    };

    // Store the trade
    this.tradeStore.append(storedTrade);

    // Note: Without maker/taker addresses from the CLOB WebSocket,
    // we can't identify whale trades in real-time.
    // This would require:
    // 1. RTDS WebSocket subscription (has user pseudonyms but not addresses)
    // 2. Subgraph/indexer queries (has full trade data but delayed)
    // 3. Custom backend that enriches trades with wallet data

    // For now, log sample trades for debugging
    if (this.tradeCounter % 100 === 0) {
      console.log(`[WhaleTracker] Processed ${this.tradeCounter} trades, ${this.tradeStore.getTradeCount()} stored`);
    }
  }

  /**
   * Manually process a trade with known wallet addresses
   * Call this when you have enriched trade data from subgraph/indexer
   */
  processEnrichedTrade(trade: StoredTrade): void {
    // Store the trade
    this.tradeStore.append(trade);

    // Check if maker or taker is a whale
    const makerWhale = this.whaleUniverse.getWhale(trade.maker);
    const takerWhale = this.whaleUniverse.getWhale(trade.taker);

    // Update positions
    if (makerWhale) {
      this.positionLedger.onTrade(trade, trade.maker);
    }
    if (takerWhale) {
      this.positionLedger.onTrade(trade, trade.taker);
    }

    // Get current market price for snapshot
    const currentPrice = this.marketPrices.get(trade.assetId) ?? trade.price;

    // Emit whale trade events
    if (makerWhale) {
      const whaleTrade = this.toWhaleTrade(trade, makerWhale, true);
      this.cacheWhaleTrade(whaleTrade, currentPrice);
      this.whaleUniverse.updateLastSeen(trade.maker);
      this.emit('whaleTrade', whaleTrade);
    }

    if (takerWhale) {
      const whaleTrade = this.toWhaleTrade(trade, takerWhale, false);
      this.cacheWhaleTrade(whaleTrade, currentPrice);
      this.whaleUniverse.updateLastSeen(trade.taker);
      this.emit('whaleTrade', whaleTrade);
    }
  }

  /**
   * Convert stored trade to whale trade
   */
  private toWhaleTrade(trade: StoredTrade, whale: WhaleInfo, isMaker: boolean): WhaleTrade {
    return {
      whale,
      marketId: trade.marketId,
      assetId: trade.assetId,
      side: trade.side,
      outcome: trade.outcome,
      price: trade.price,
      size: trade.size,
      sizeUsdc: trade.sizeUsdc,
      timestamp: trade.timestamp,
      isMaker,
    };
  }

  /**
   * Cache whale trade with price snapshot
   */
  private cacheWhaleTrade(trade: WhaleTrade, priceAtTrade: number): void {
    this.cachedWhaleTrades.push({
      trade,
      priceAtTrade,
      timestamp: Date.now(),
    });

    // Trim if over limit
    if (this.cachedWhaleTrades.length > MAX_CACHED_WHALE_TRADES) {
      this.cachedWhaleTrades = this.cachedWhaleTrades.slice(-MAX_CACHED_WHALE_TRADES);
    }
  }

  /**
   * Cleanup old cached whale trades
   */
  private cleanupCachedTrades(): void {
    const cutoff = Date.now() - WHALE_TRADE_MAX_AGE_MS;
    const oldLength = this.cachedWhaleTrades.length;

    this.cachedWhaleTrades = this.cachedWhaleTrades.filter(
      ct => ct.timestamp >= cutoff
    );

    if (oldLength !== this.cachedWhaleTrades.length) {
      console.log(`[WhaleTracker] Cleaned up ${oldLength - this.cachedWhaleTrades.length} old whale trades`);
    }
  }

  // Public getters

  /**
   * Get whale by address
   */
  getWhale(address: string): WhaleInfo | undefined {
    return this.whaleUniverse.getWhale(address);
  }

  /**
   * Check if address is a tracked whale
   */
  isWhale(address: string): boolean {
    return this.whaleUniverse.isWhale(address);
  }

  /**
   * Get all tracked whales
   */
  getAllWhales(): WhaleInfo[] {
    return this.whaleUniverse.getAllWhales();
  }

  /**
   * Get top whales by volume
   */
  getTopByVolume(n: number = 10): WhaleInfo[] {
    return this.whaleUniverse.getTopByVolume(n);
  }

  /**
   * Get top whales by PnL
   */
  getTopByPnL(n: number = 10): WhaleInfo[] {
    return this.whaleUniverse.getTopByPnL(n);
  }

  /**
   * Get cached whale trades for a market
   */
  getWhaleTrades(marketId: string): CachedWhaleTrade[] {
    return this.cachedWhaleTrades.filter(
      ct => ct.trade.marketId === marketId
    );
  }

  /**
   * Get all recent whale trades
   */
  getRecentWhaleTrades(limit: number = 50): CachedWhaleTrade[] {
    return this.cachedWhaleTrades
      .slice(-limit)
      .reverse();
  }

  /**
   * Get all trades for a specific whale address
   */
  getWhaleTradesByAddress(address: string, limit: number = 100): CachedWhaleTrade[] {
    const addrLower = address.toLowerCase();
    return this.cachedWhaleTrades
      .filter(ct => ct.trade.whale.address.toLowerCase() === addrLower)
      .slice(-limit)
      .reverse();
  }

  /**
   * Get all positions for a specific whale
   */
  getWhalePositions(address: string): import('./types.js').Position[] {
    return this.positionLedger.getWalletPositions(address);
  }

  /**
   * Get total realized PnL for a whale from tracked positions
   */
  getWhaleRealizedPnL(address: string): number {
    return this.positionLedger.getTotalRealizedPnL(address);
  }

  /**
   * Get position for a whale
   */
  getWhalePosition(address: string, marketId: string, outcome: 'YES' | 'NO') {
    return this.positionLedger.getPosition(address, marketId, outcome);
  }

  /**
   * Get position reduction (for exit detection)
   */
  getPositionReduction(address: string, marketId: string, outcome: 'YES' | 'NO'): number {
    return this.positionLedger.getPositionReduction(address, marketId, outcome);
  }

  /**
   * Get stats for debugging
   */
  getStats() {
    return {
      trades: this.tradeStore.getStats(),
      whales: this.whaleUniverse.getStats(),
      positions: this.positionLedger.getStats(),
      cachedWhaleTrades: this.cachedWhaleTrades.length,
      activityMonitor: this.activityMonitor.getStats(),
      experts: this.expertTracker.getStats(),
    };
  }

  /**
   * Get experts by category
   */
  getExpertsByCategory(category: MarketCategory): ExpertProfile[] {
    return this.expertTracker.getExpertsByCategory(category, (addr) => {
      const whale = this.whaleUniverse.getWhale(addr);
      if (!whale) return undefined;
      return { name: whale.name, tier: whale.tier, pnl30d: whale.pnl30d };
    });
  }

  /**
   * Get all tracked experts
   */
  getAllExperts(limit: number = 50): ExpertProfile[] {
    return this.expertTracker.getAllExperts((addr) => {
      const whale = this.whaleUniverse.getWhale(addr);
      if (!whale) return undefined;
      return { name: whale.name, tier: whale.tier, pnl30d: whale.pnl30d };
    }, limit);
  }

  /**
   * Get specialties for a specific trader
   */
  getTraderSpecialties(address: string) {
    return this.expertTracker.getSpecialties(address);
  }

  /**
   * Detect market category from title
   */
  detectMarketCategory(title: string): MarketCategory {
    return this.expertTracker.detectCategory(title);
  }

  /**
   * Force rebuild (for testing)
   */
  async forceRebuild(): Promise<void> {
    await this.whaleUniverse.forceRebuild();
  }
}

// Re-export types and modules
export type {
  WhaleInfo,
  WhaleTrade,
  StoredTrade,
  CachedWhaleTrade,
  WhaleEdgeSignal,
  MarketCategory,
  CategoryStats,
  ExpertProfile,
  ExpertSpecialty,
} from './types.js';
export { TradeStore } from './trade-store.js';
export { WhaleUniverse } from './whale-universe.js';
export { PositionLedger } from './position-ledger.js';
export { WhaleActivityMonitor } from './activity-monitor.js';
export { ExpertTracker } from './expert-tracker.js';
export { COPY_THRESHOLD, isCopyable, getCopyRecommendation } from './copy-score.js';

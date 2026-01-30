/**
 * Trade Store
 *
 * Stores all trades for computing wallet statistics.
 * Maintains a rolling window of trades for whale universe computation.
 */

import type { StoredTrade, TradeQueryOptions, WalletStats } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;

// Maximum trades to keep in memory (roughly 30 days of moderate activity)
const MAX_TRADES = 100_000;

// Minimum requirements for whale consideration
const MIN_TRADES_FOR_WHALE = 10;
const MIN_VOLUME_FOR_WHALE = 10_000; // $10k

export class TradeStore {
  private trades: StoredTrade[] = [];
  private tradeIndex: Map<string, number> = new Map(); // id -> index for dedup
  private walletTradeIndex: Map<string, Set<number>> = new Map(); // wallet -> trade indices

  /**
   * Append a trade to the store
   */
  append(trade: StoredTrade): void {
    // Dedup by trade ID
    if (this.tradeIndex.has(trade.id)) {
      return;
    }

    const index = this.trades.length;
    this.trades.push(trade);
    this.tradeIndex.set(trade.id, index);

    // Index by wallet addresses
    this.indexByWallet(trade.maker, index);
    this.indexByWallet(trade.taker, index);

    // Cleanup if over limit
    if (this.trades.length > MAX_TRADES) {
      this.cleanup();
    }
  }

  private indexByWallet(wallet: string, index: number): void {
    if (!wallet) return;
    let indices = this.walletTradeIndex.get(wallet);
    if (!indices) {
      indices = new Set();
      this.walletTradeIndex.set(wallet, indices);
    }
    indices.add(index);
  }

  /**
   * Query trades with filters
   */
  query(options: TradeQueryOptions = {}): StoredTrade[] {
    let result = this.trades;

    // Filter by wallet
    if (options.wallet) {
      const indices = this.walletTradeIndex.get(options.wallet);
      if (!indices || indices.size === 0) {
        return [];
      }
      result = [...indices].map(i => this.trades[i]).filter(Boolean);
    }

    // Filter by market
    if (options.marketId) {
      result = result.filter(t => t.marketId === options.marketId);
    }

    // Filter by time range
    if (options.startTime) {
      result = result.filter(t => t.timestamp >= options.startTime!);
    }
    if (options.endTime) {
      result = result.filter(t => t.timestamp <= options.endTime!);
    }

    // Sort by timestamp descending
    result = result.sort((a, b) => b.timestamp - a.timestamp);

    // Apply limit
    if (options.limit && options.limit > 0) {
      result = result.slice(0, options.limit);
    }

    return result;
  }

  /**
   * Get all unique wallet addresses
   */
  getWallets(): string[] {
    return [...this.walletTradeIndex.keys()];
  }

  /**
   * Compute wallet statistics for a given time window
   */
  computeWalletStats(window: '7d' | '30d'): WalletStats[] {
    const now = Date.now();
    const windowMs = window === '7d' ? WEEK_MS : MONTH_MS;
    const cutoff = now - windowMs;

    // Get trades in window
    const recentTrades = this.trades.filter(t => t.timestamp >= cutoff);

    // Group by wallet
    const walletTrades = new Map<string, StoredTrade[]>();

    for (const trade of recentTrades) {
      // Add to maker's trades
      if (trade.maker) {
        const trades = walletTrades.get(trade.maker) || [];
        trades.push(trade);
        walletTrades.set(trade.maker, trades);
      }
      // Add to taker's trades
      if (trade.taker) {
        const trades = walletTrades.get(trade.taker) || [];
        trades.push(trade);
        walletTrades.set(trade.taker, trades);
      }
    }

    // Compute stats for each wallet
    const stats: WalletStats[] = [];

    for (const [address, trades] of walletTrades) {
      if (trades.length < MIN_TRADES_FOR_WHALE) continue;

      const volume = trades.reduce((sum, t) => sum + t.sizeUsdc, 0);
      if (volume < MIN_VOLUME_FOR_WHALE) continue;

      // Compute PnL (simplified: sum of (sell price - buy price) * size)
      // This is a rough approximation since we don't have full position tracking here
      const pnl = this.estimatePnL(address, trades);

      // Compute maker ratio
      const makerTrades = trades.filter(t => t.maker === address);
      const makerRatio = makerTrades.length / trades.length;

      // Compute average market volume (placeholder - would need market data)
      const avgMarketVolume = 50_000; // Default assumption

      // Compute win rate (trades that were profitable)
      const winRate = 0.5; // Placeholder - requires resolution data

      // Compute PnL volatility (simplified)
      const pnlVolatility = 0.3; // Placeholder

      // Compute early entry score (placeholder - requires price history)
      const earlyEntryScore = 50; // Default

      // Compute avg hold time (placeholder - requires position tracking)
      const avgHoldTimeHours = 24; // Default

      stats.push({
        address,
        volume7d: window === '7d' ? volume : 0,
        volume30d: window === '30d' ? volume : 0,
        pnl7d: window === '7d' ? pnl : 0,
        pnl30d: window === '30d' ? pnl : 0,
        tradeCount7d: window === '7d' ? trades.length : 0,
        tradeCount30d: window === '30d' ? trades.length : 0,
        avgHoldTimeHours,
        avgMarketVolume,
        pnlVolatility,
        makerRatio,
        winRate,
        earlyEntryScore,
      });
    }

    return stats;
  }

  /**
   * Estimate PnL from trades (simplified)
   */
  private estimatePnL(wallet: string, trades: StoredTrade[]): number {
    // Group by market and outcome
    const positions = new Map<string, { buys: number; sells: number; buyValue: number; sellValue: number }>();

    for (const trade of trades) {
      const key = `${trade.marketId}:${trade.outcome}`;
      const pos = positions.get(key) || { buys: 0, sells: 0, buyValue: 0, sellValue: 0 };

      const isBuyer = (trade.side === 'BUY' && trade.taker === wallet) ||
                      (trade.side === 'SELL' && trade.maker === wallet);

      if (isBuyer) {
        pos.buys += trade.size;
        pos.buyValue += trade.sizeUsdc;
      } else {
        pos.sells += trade.size;
        pos.sellValue += trade.sizeUsdc;
      }

      positions.set(key, pos);
    }

    // Sum realized PnL (sell value - buy value for closed positions)
    let totalPnL = 0;
    for (const pos of positions.values()) {
      const closedShares = Math.min(pos.buys, pos.sells);
      if (closedShares > 0) {
        const avgBuy = pos.buyValue / pos.buys;
        const avgSell = pos.sellValue / pos.sells;
        totalPnL += (avgSell - avgBuy) * closedShares;
      }
    }

    return totalPnL;
  }

  /**
   * Get trade count
   */
  getTradeCount(): number {
    return this.trades.length;
  }

  /**
   * Get wallet count
   */
  getWalletCount(): number {
    return this.walletTradeIndex.size;
  }

  /**
   * Clean up old trades beyond the retention window
   */
  private cleanup(): void {
    const cutoff = Date.now() - MONTH_MS;
    const oldLength = this.trades.length;

    // Find the index where we should start keeping trades
    let keepFrom = 0;
    for (let i = 0; i < this.trades.length; i++) {
      if (this.trades[i].timestamp >= cutoff) {
        keepFrom = i;
        break;
      }
    }

    if (keepFrom === 0) {
      // Also trim if over max even within time window
      if (this.trades.length > MAX_TRADES) {
        keepFrom = this.trades.length - MAX_TRADES;
      } else {
        return; // Nothing to clean
      }
    }

    // Slice and rebuild indices
    this.trades = this.trades.slice(keepFrom);

    // Rebuild indices
    this.tradeIndex.clear();
    this.walletTradeIndex.clear();

    for (let i = 0; i < this.trades.length; i++) {
      const trade = this.trades[i];
      this.tradeIndex.set(trade.id, i);
      this.indexByWallet(trade.maker, i);
      this.indexByWallet(trade.taker, i);
    }

    console.log(`[TradeStore] Cleaned up ${oldLength - this.trades.length} old trades, ${this.trades.length} remaining`);
  }

  /**
   * Get stats for debugging
   */
  getStats(): { trades: number; wallets: number; oldestTrade: number } {
    return {
      trades: this.trades.length,
      wallets: this.walletTradeIndex.size,
      oldestTrade: this.trades.length > 0 ? this.trades[0].timestamp : 0,
    };
  }
}

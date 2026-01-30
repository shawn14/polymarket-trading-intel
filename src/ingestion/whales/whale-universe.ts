/**
 * Whale Universe
 *
 * Computes and maintains the set of tracked whales from our own trade data.
 * Leaderboard is only used for bootstrap and name enrichment.
 */

import type { WhaleInfo, WalletStats, WhaleTier } from './types.js';
import type { TradeStore } from './trade-store.js';

// Top N wallets by volume to track
const TOP_BY_VOLUME = 50;
// Top N wallets by PnL to track
const TOP_BY_PNL = 50;
// Top 10 threshold (top 10 by either metric)
const TOP_10_THRESHOLD = 10;

// Minimum requirements
const MIN_TRADES = 10;
const MIN_VOLUME = 10_000; // $10k

// Rebuild interval
const REBUILD_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export class WhaleUniverse {
  private whales: Map<string, WhaleInfo> = new Map();
  private tradeStore: TradeStore;
  private lastRebuild = 0;
  private rebuildInterval = REBUILD_INTERVAL_MS;

  // Name enrichment from leaderboard (optional)
  private nameCache: Map<string, string> = new Map();

  constructor(tradeStore: TradeStore) {
    this.tradeStore = tradeStore;
  }

  /**
   * Get a whale by address
   */
  getWhale(address: string): WhaleInfo | undefined {
    return this.whales.get(address.toLowerCase());
  }

  /**
   * Check if address is a tracked whale
   */
  isWhale(address: string): boolean {
    return this.whales.has(address.toLowerCase());
  }

  /**
   * Get all tracked whales
   */
  getAllWhales(): WhaleInfo[] {
    return [...this.whales.values()];
  }

  /**
   * Get top N whales by volume
   */
  getTopByVolume(n: number = 10): WhaleInfo[] {
    return [...this.whales.values()]
      .sort((a, b) => b.volume7d - a.volume7d)
      .slice(0, n);
  }

  /**
   * Get top N whales by PnL
   */
  getTopByPnL(n: number = 10): WhaleInfo[] {
    return [...this.whales.values()]
      .sort((a, b) => b.pnl7d - a.pnl7d)
      .slice(0, n);
  }

  /**
   * Rebuild the whale universe from trade data
   * Should be called hourly
   */
  async rebuild(): Promise<void> {
    const now = Date.now();

    // Rate limit rebuilds
    if (now - this.lastRebuild < this.rebuildInterval / 2) {
      return;
    }

    console.log('[WhaleUniverse] Rebuilding whale set from trade data...');

    // Get 7-day stats
    const stats7d = this.tradeStore.computeWalletStats('7d');

    // Get 30-day stats
    const stats30d = this.tradeStore.computeWalletStats('30d');

    // Merge stats
    const mergedStats = this.mergeStats(stats7d, stats30d);

    // Filter and rank
    const ranked = this.rankWallets(mergedStats);

    // If we have trade-derived whales, use them
    // Otherwise, keep the existing (leaderboard-seeded) whales
    if (ranked.length > 0) {
      // Preserve name cache when replacing
      const oldNames = new Map<string, string>();
      for (const whale of this.whales.values()) {
        if (whale.name) {
          oldNames.set(whale.address.toLowerCase(), whale.name);
        }
      }

      this.whales.clear();
      for (const whale of ranked) {
        // Restore name if we had it
        const existingName = oldNames.get(whale.address.toLowerCase());
        if (existingName && !whale.name) {
          whale.name = existingName;
        }
        this.whales.set(whale.address.toLowerCase(), whale);
      }
      console.log(`[WhaleUniverse] Rebuilt with ${this.whales.size} tracked whales from trade data`);
    } else {
      // Keep existing whales (from leaderboard seed)
      console.log(`[WhaleUniverse] No trade data yet, keeping ${this.whales.size} leaderboard whales`);
    }

    this.lastRebuild = now;
  }

  /**
   * Merge 7d and 30d stats
   */
  private mergeStats(stats7d: WalletStats[], stats30d: WalletStats[]): WalletStats[] {
    const merged = new Map<string, WalletStats>();

    // Add 7d stats
    for (const s of stats7d) {
      merged.set(s.address.toLowerCase(), { ...s });
    }

    // Merge 30d stats
    for (const s of stats30d) {
      const addr = s.address.toLowerCase();
      const existing = merged.get(addr);
      if (existing) {
        existing.volume30d = s.volume30d;
        existing.pnl30d = s.pnl30d;
        existing.tradeCount30d = s.tradeCount30d;
      } else {
        merged.set(addr, { ...s });
      }
    }

    return [...merged.values()];
  }

  /**
   * Rank wallets and assign tiers
   */
  private rankWallets(stats: WalletStats[]): WhaleInfo[] {
    // Filter by minimum requirements
    const qualified = stats.filter(
      s => s.tradeCount7d >= MIN_TRADES || s.tradeCount30d >= MIN_TRADES
    ).filter(
      s => s.volume7d >= MIN_VOLUME || s.volume30d >= MIN_VOLUME
    );

    // Rank by volume
    const byVolume = [...qualified].sort((a, b) =>
      Math.max(b.volume7d, b.volume30d / 4) - Math.max(a.volume7d, a.volume30d / 4)
    );

    // Rank by PnL
    const byPnL = [...qualified].sort((a, b) =>
      Math.max(b.pnl7d, b.pnl30d / 4) - Math.max(a.pnl7d, a.pnl30d / 4)
    );

    // Get top by each metric
    const topVolumeAddrs = new Set(byVolume.slice(0, TOP_BY_VOLUME).map(s => s.address.toLowerCase()));
    const topPnLAddrs = new Set(byPnL.slice(0, TOP_BY_PNL).map(s => s.address.toLowerCase()));

    // Union of both sets
    const trackedAddrs = new Set([...topVolumeAddrs, ...topPnLAddrs]);

    // Determine top 10 (in top 10 of BOTH or top 5 of either)
    const top10VolumeAddrs = new Set(byVolume.slice(0, TOP_10_THRESHOLD).map(s => s.address.toLowerCase()));
    const top10PnLAddrs = new Set(byPnL.slice(0, TOP_10_THRESHOLD).map(s => s.address.toLowerCase()));

    // Build whale info
    const whales: WhaleInfo[] = [];

    for (const addr of trackedAddrs) {
      const stat = stats.find(s => s.address.toLowerCase() === addr);
      if (!stat) continue;

      // Determine tier
      let tier: WhaleTier = 'tracked';
      const inTop10Volume = top10VolumeAddrs.has(addr);
      const inTop10PnL = top10PnLAddrs.has(addr);

      if (inTop10Volume && inTop10PnL) {
        tier = 'top10';
      } else if (inTop10Volume || inTop10PnL) {
        // Check if in top 5 of either
        const volumeRank = byVolume.findIndex(s => s.address.toLowerCase() === addr);
        const pnlRank = byPnL.findIndex(s => s.address.toLowerCase() === addr);
        if (volumeRank < 5 || pnlRank < 5) {
          tier = 'top10';
        } else if (volumeRank < TOP_10_THRESHOLD || pnlRank < TOP_10_THRESHOLD) {
          tier = 'top10';
        } else {
          tier = 'top50';
        }
      } else {
        tier = 'top50';
      }

      // Calculate copy suitability (simplified version, detailed in copy-score.ts)
      const copySuitability = this.calculateCopySuitability(stat);

      whales.push({
        address: stat.address,
        name: this.nameCache.get(stat.address.toLowerCase()),
        pnl7d: stat.pnl7d,
        pnl30d: stat.pnl30d,
        volume7d: stat.volume7d,
        volume30d: stat.volume30d,
        tradeCount7d: stat.tradeCount7d,
        tradeCount30d: stat.tradeCount30d,
        earlyEntryScore: stat.earlyEntryScore,
        copySuitability,
        tier,
        lastSeen: Date.now(), // Will be updated on trades
      });
    }

    return whales;
  }

  /**
   * Simple copy suitability calculation
   * Full version in copy-score.ts
   */
  private calculateCopySuitability(stats: WalletStats): number {
    let score = 50;

    // Longer hold = easier to copy
    if (stats.avgHoldTimeHours > 24) score += 15;
    else if (stats.avgHoldTimeHours > 6) score += 8;
    else if (stats.avgHoldTimeHours < 1) score -= 20;

    // Trades liquid markets = lower slippage for copier
    if (stats.avgMarketVolume > 100_000) score += 10;
    else if (stats.avgMarketVolume < 10_000) score -= 15;

    // Consistent PnL = predictable
    if (stats.pnlVolatility < 0.2) score += 10;
    else if (stats.pnlVolatility > 0.5) score -= 10;

    // Taker-heavy = easier to copy (orders visible)
    if (stats.makerRatio < 0.3) score += 5;
    else if (stats.makerRatio > 0.7) score -= 10;

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Enrich with names from leaderboard
   */
  enrichWithNames(entries: Array<{ address: string; displayName?: string }>): void {
    for (const entry of entries) {
      if (entry.displayName) {
        this.nameCache.set(entry.address.toLowerCase(), entry.displayName);

        // Update existing whale if present
        const whale = this.whales.get(entry.address.toLowerCase());
        if (whale) {
          whale.name = entry.displayName;
        }
      }
    }
  }

  /**
   * Seed whales from leaderboard entries
   * Used to bootstrap the whale list before we have our own trade data
   */
  seedFromLeaderboard(entries: Array<{ rank: number; address: string; displayName?: string; pnl: number; volume: number }>): void {
    console.log(`[WhaleUniverse] Seeding ${entries.length} whales from leaderboard...`);

    // Clear existing whales (we're bootstrapping)
    this.whales.clear();

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const addr = entry.address.toLowerCase();

      // Determine tier based on rank
      let tier: WhaleTier = 'tracked';
      if (entry.rank <= 10) {
        tier = 'top10';
      } else if (entry.rank <= 50) {
        tier = 'top50';
      }

      // Store name in cache
      if (entry.displayName) {
        this.nameCache.set(addr, entry.displayName);
      }

      const whale: WhaleInfo = {
        address: entry.address,
        name: entry.displayName,
        pnl7d: entry.pnl, // All-time PnL used as proxy
        pnl30d: entry.pnl,
        volume7d: entry.volume,
        volume30d: entry.volume,
        tradeCount7d: 0, // Unknown
        tradeCount30d: 0,
        earlyEntryScore: 0, // Will be computed as trades come in
        copySuitability: tier === 'top10' ? 70 : tier === 'top50' ? 60 : 50, // Default based on tier
        tier,
        lastSeen: Date.now(),
      };

      this.whales.set(addr, whale);
    }

    this.lastRebuild = Date.now();
    console.log(`[WhaleUniverse] Seeded ${this.whales.size} whales (${this.getStats().top10} top10, ${this.getStats().top50} top50)`);
  }

  /**
   * Update whale's last seen timestamp
   */
  updateLastSeen(address: string): void {
    const whale = this.whales.get(address.toLowerCase());
    if (whale) {
      whale.lastSeen = Date.now();
    }
  }

  /**
   * Get stats for debugging
   */
  getStats(): { total: number; top10: number; top50: number; lastRebuild: number } {
    let top10 = 0;
    let top50 = 0;
    for (const whale of this.whales.values()) {
      if (whale.tier === 'top10') top10++;
      else if (whale.tier === 'top50') top50++;
    }
    return {
      total: this.whales.size,
      top10,
      top50,
      lastRebuild: this.lastRebuild,
    };
  }

  /**
   * Force immediate rebuild (for testing)
   */
  async forceRebuild(): Promise<void> {
    this.lastRebuild = 0;
    await this.rebuild();
  }
}

/**
 * Expert Tracker
 *
 * Identifies specialized traders ("experts") by analyzing their trading patterns
 * and categorizing their trades by market type.
 */

import type {
  MarketCategory,
  CategoryStats,
  ExpertProfile,
  ExpertSpecialty,
  WhaleTrade,
  WhaleTier,
} from './types.js';

// Keywords for category detection
const CATEGORY_KEYWORDS: Record<MarketCategory, string[]> = {
  sports: [
    'nba', 'nfl', 'mlb', 'nhl', 'pga', 'atp', 'wta', 'ufc', 'mma',
    'basketball', 'football', 'baseball', 'hockey', 'tennis', 'golf',
    'lakers', 'celtics', 'warriors', 'bulls', 'heat', 'nets',
    'chiefs', 'eagles', 'cowboys', '49ers', 'patriots',
    'yankees', 'dodgers', 'mets', 'red sox',
    'spread', 'over/under', 'o/u', 'moneyline', 'finals', 'championship',
    'game', 'match', 'score', 'points', 'goals', 'touchdowns',
    'rebounds', 'assists', 'yards', 'hits', 'strikeouts',
    'win', 'beat', 'defeat', 'super bowl', 'world series',
  ],
  crypto: [
    'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'xrp',
    'crypto', 'token', 'coin', 'blockchain', 'defi', 'nft',
    'price', 'above', 'below', '$100k', '$50k', 'ath', 'all-time high',
  ],
  politics: [
    'trump', 'biden', 'harris', 'desantis', 'obama', 'president',
    'republican', 'democrat', 'gop', 'congress', 'senate', 'house',
    'election', 'vote', 'primary', 'nominee', 'impeach',
    'governor', 'mayor', 'cabinet', 'secretary',
    'legislation', 'bill', 'act', 'law',
  ],
  weather: [
    'hurricane', 'storm', 'tropical', 'cyclone', 'typhoon',
    'tornado', 'earthquake', 'flood', 'wildfire',
    'temperature', 'heat', 'cold', 'snow', 'rain',
    'landfall', 'category', 'nhc', 'noaa', 'nws',
  ],
  entertainment: [
    'oscars', 'grammys', 'emmys', 'golden globes', 'mtv',
    'movie', 'film', 'box office', 'netflix', 'disney',
    'music', 'album', 'billboard', 'spotify',
    'celebrity', 'actor', 'actress', 'singer',
    'tv show', 'series', 'streaming',
  ],
  finance: [
    'fed', 'fomc', 'interest rate', 'inflation', 'cpi', 'gdp',
    'stock', 's&p', 'dow', 'nasdaq', 'earnings',
    'treasury', 'bond', 'yield', 'recession',
    'employment', 'jobs', 'unemployment',
  ],
  science: [
    'spacex', 'nasa', 'rocket', 'launch', 'space',
    'ai', 'artificial intelligence', 'gpt', 'openai', 'anthropic',
    'vaccine', 'fda', 'clinical', 'trial',
    'climate', 'carbon', 'emissions',
  ],
  other: [],
};

// Minimum trades to be considered an "expert" in a category
const MIN_TRADES_FOR_EXPERT = 5;

// Minimum win rate to be considered an "expert"
const MIN_WIN_RATE_FOR_EXPERT = 55;

export class ExpertTracker {
  // address -> category -> stats
  private categoryStats: Map<string, Map<MarketCategory, CategoryStats>> = new Map();

  // Track all observed trades
  private totalTrades = 0;

  /**
   * Detect the category of a market from its title
   */
  detectCategory(title: string): MarketCategory {
    const titleLower = title.toLowerCase();

    // Check each category's keywords
    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS) as [MarketCategory, string[]][]) {
      if (category === 'other') continue;

      for (const keyword of keywords) {
        if (titleLower.includes(keyword)) {
          return category;
        }
      }
    }

    return 'other';
  }

  /**
   * Record a trade and update category stats
   */
  recordTrade(trade: WhaleTrade): void {
    const address = trade.whale.address.toLowerCase();
    const category = this.detectCategory(trade.marketTitle || '');

    this.totalTrades++;

    // Initialize stats map if needed
    if (!this.categoryStats.has(address)) {
      this.categoryStats.set(address, new Map());
    }

    const addressStats = this.categoryStats.get(address)!;
    if (!addressStats.has(category)) {
      addressStats.set(category, {
        category,
        tradeCount: 0,
        totalVolume: 0,
        winCount: 0,
        lossCount: 0,
        pendingCount: 0,
        avgEntry: 0,
        profitEstimate: 0,
      });
    }

    const stats = addressStats.get(category)!;

    // Update stats
    const oldTotal = stats.avgEntry * stats.tradeCount;
    stats.tradeCount++;
    stats.totalVolume += trade.sizeUsdc;
    stats.avgEntry = (oldTotal + trade.price) / stats.tradeCount;
    stats.pendingCount++; // Will be updated when market resolves

    // Estimate profit based on entry price and direction
    // This is a rough estimate - actual profit depends on resolution
    if (trade.side === 'BUY') {
      if (trade.outcome === 'YES') {
        // Bought YES - profit if resolves YES
        // Estimated profit = shares * (1 - entryPrice) if wins, -shares * entryPrice if loses
        // For now, assume 50% win rate
        stats.profitEstimate += trade.sizeUsdc * (0.5 - trade.price);
      } else {
        // Bought NO - profit if resolves NO
        stats.profitEstimate += trade.sizeUsdc * (0.5 - trade.price);
      }
    }
  }

  /**
   * Record a win for a trader in a category
   */
  recordWin(address: string, category: MarketCategory, profit: number): void {
    const addressStats = this.categoryStats.get(address.toLowerCase());
    if (!addressStats) return;

    const stats = addressStats.get(category);
    if (!stats) return;

    stats.winCount++;
    stats.pendingCount = Math.max(0, stats.pendingCount - 1);
    stats.profitEstimate += profit;
  }

  /**
   * Record a loss for a trader in a category
   */
  recordLoss(address: string, category: MarketCategory, loss: number): void {
    const addressStats = this.categoryStats.get(address.toLowerCase());
    if (!addressStats) return;

    const stats = addressStats.get(category);
    if (!stats) return;

    stats.lossCount++;
    stats.pendingCount = Math.max(0, stats.pendingCount - 1);
    stats.profitEstimate -= loss;
  }

  /**
   * Get category stats for a trader
   */
  getCategoryStats(address: string): CategoryStats[] {
    const addressStats = this.categoryStats.get(address.toLowerCase());
    if (!addressStats) return [];

    return Array.from(addressStats.values())
      .filter(s => s.tradeCount > 0)
      .sort((a, b) => b.totalVolume - a.totalVolume);
  }

  /**
   * Get specialties for a trader (categories where they have edge)
   */
  getSpecialties(address: string): ExpertSpecialty[] {
    const stats = this.getCategoryStats(address);
    const specialties: ExpertSpecialty[] = [];

    for (const catStats of stats) {
      if (catStats.tradeCount < 3) continue; // Need at least 3 trades

      const resolvedTrades = catStats.winCount + catStats.lossCount;
      const winRate = resolvedTrades > 0
        ? (catStats.winCount / resolvedTrades) * 100
        : 50; // Assume 50% if no resolutions yet

      // Determine confidence based on trade count
      let confidence: 'high' | 'medium' | 'low';
      if (catStats.tradeCount >= 20) {
        confidence = 'high';
      } else if (catStats.tradeCount >= 10) {
        confidence = 'medium';
      } else {
        confidence = 'low';
      }

      specialties.push({
        category: catStats.category,
        winRate,
        tradeCount: catStats.tradeCount,
        totalVolume: catStats.totalVolume,
        confidence,
        profitability: catStats.profitEstimate,
      });
    }

    // Sort by volume (most active = most likely specialty)
    return specialties.sort((a, b) => b.totalVolume - a.totalVolume);
  }

  /**
   * Get all experts in a specific category
   */
  getExpertsByCategory(
    category: MarketCategory,
    whaleInfoGetter: (addr: string) => { name?: string; tier: WhaleTier; pnl30d: number } | undefined
  ): ExpertProfile[] {
    const experts: ExpertProfile[] = [];

    for (const [address, statsMap] of this.categoryStats) {
      const catStats = statsMap.get(category);
      if (!catStats || catStats.tradeCount < MIN_TRADES_FOR_EXPERT) continue;

      const resolvedTrades = catStats.winCount + catStats.lossCount;
      const winRate = resolvedTrades > 0
        ? (catStats.winCount / resolvedTrades) * 100
        : 50;

      // Only include if they meet the win rate threshold or have no resolved trades yet
      if (resolvedTrades > 0 && winRate < MIN_WIN_RATE_FOR_EXPERT) continue;

      const whaleInfo = whaleInfoGetter(address);
      if (!whaleInfo) continue;

      const allStats = this.getCategoryStats(address);
      const totalTrades = allStats.reduce((sum, s) => sum + s.tradeCount, 0);

      experts.push({
        address,
        name: whaleInfo.name,
        tier: whaleInfo.tier,
        pnl30d: whaleInfo.pnl30d,
        specialties: [{
          category,
          winRate,
          tradeCount: catStats.tradeCount,
          totalVolume: catStats.totalVolume,
          confidence: catStats.tradeCount >= 20 ? 'high' : catStats.tradeCount >= 10 ? 'medium' : 'low',
          profitability: catStats.profitEstimate,
        }],
        overallWinRate: winRate,
        totalTrackedTrades: totalTrades,
        lastActive: Date.now(), // Could track actual last trade time
      });
    }

    // Sort by trade count in this category (most active first)
    return experts.sort((a, b) => b.specialties[0].tradeCount - a.specialties[0].tradeCount);
  }

  /**
   * Get top experts across all categories
   */
  getAllExperts(
    whaleInfoGetter: (addr: string) => { name?: string; tier: WhaleTier; pnl30d: number } | undefined,
    limit: number = 50
  ): ExpertProfile[] {
    const expertMap = new Map<string, ExpertProfile>();

    for (const [address, statsMap] of this.categoryStats) {
      const whaleInfo = whaleInfoGetter(address);
      if (!whaleInfo) continue;

      const specialties = this.getSpecialties(address);
      if (specialties.length === 0) continue;

      const totalTrades = specialties.reduce((sum, s) => sum + s.tradeCount, 0);
      const totalResolved = specialties.reduce((sum, s) => {
        const stats = statsMap.get(s.category);
        return sum + (stats?.winCount || 0) + (stats?.lossCount || 0);
      }, 0);
      const totalWins = specialties.reduce((sum, s) => {
        const stats = statsMap.get(s.category);
        return sum + (stats?.winCount || 0);
      }, 0);

      const overallWinRate = totalResolved > 0 ? (totalWins / totalResolved) * 100 : undefined;

      expertMap.set(address, {
        address,
        name: whaleInfo.name,
        tier: whaleInfo.tier,
        pnl30d: whaleInfo.pnl30d,
        specialties: specialties.slice(0, 3), // Top 3 specialties
        overallWinRate,
        totalTrackedTrades: totalTrades,
        lastActive: Date.now(),
      });
    }

    // Sort by total tracked trades
    return Array.from(expertMap.values())
      .sort((a, b) => b.totalTrackedTrades - a.totalTrackedTrades)
      .slice(0, limit);
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      totalTrades: this.totalTrades,
      uniqueTraders: this.categoryStats.size,
    };
  }
}

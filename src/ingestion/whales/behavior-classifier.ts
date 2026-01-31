/**
 * Behavior Classifier
 *
 * Classifies whale trades with behavioral patterns to surface intent:
 * - TAIL: Extreme conviction bets (97%+ NO sells or 3%- YES buys)
 * - ARB: Buying both sides within 5 minutes (profitable redemption)
 * - SCALP: Exit within 1 hour of entry (short-term flip)
 * - HEDGE: Opposite of prior position (risk reduction)
 * - CHASE: Entry after 5%+ move in same direction (momentum following)
 * - STANDARD: No special behavior detected
 */

import type { WhaleTrade, BehaviorClassification, TradeBehavior } from './types.js';

// Configurable thresholds
export const BEHAVIOR_THRESHOLDS = {
  SCOOP_LOW: 0.01,           // 1% - near-zero for SCOOP detection (buying dust)
  TAIL_HIGH: 0.97,           // 97% - extreme high price for LOCK/TAIL detection
  TAIL_LOW: 0.03,            // 3% - extreme low price for TAIL detection
  ARB_WINDOW_MS: 300000,     // 5 minutes - window for ARB detection
  SCALP_WINDOW_MS: 3600000,  // 1 hour - window for SCALP detection
  HEDGE_MIN_REDUCTION: 0.25, // 25% - minimum position reduction for HEDGE
  CHASE_THRESHOLD: 0.05,     // 5% - minimum price move for CHASE detection
  CHASE_LOOKBACK_MS: 1800000, // 30 minutes - lookback window for CHASE
  // New behavior thresholds
  DCA_PRICE_TOLERANCE: 0.05, // 5% - price tolerance for DCA detection
  DCA_MIN_TRADES: 3,         // 3+ trades for DCA
  DCA_WINDOW_MS: 14400000,   // 4 hours - window for DCA detection
  STACK_MIN_TRADES: 3,       // 3+ trades for STACK
  STACK_MIN_TOTAL: 1000,     // $1000 total for STACK
  STACK_WINDOW_MS: 86400000, // 24 hours - window for STACK detection
  EXIT_REDUCTION: 0.80,      // 80% - position reduction for EXIT
  FLIP_WINDOW_MS: 1800000,   // 30 minutes - window for FLIP detection
  FADE_THRESHOLD: 0.05,      // 5% - price move threshold for FADE detection
};

// Trade record for history tracking
interface TradeRecord {
  trade: WhaleTrade;
  timestamp: number;
}

// Price history point
interface PricePoint {
  price: number;
  timestamp: number;
}

export class BehaviorClassifier {
  // Recent trades by wallet:marketId for SCALP/ARB/HEDGE detection
  private recentTrades: Map<string, TradeRecord[]> = new Map();

  // Price history by marketId for CHASE detection
  private priceHistory: Map<string, PricePoint[]> = new Map();

  // Behavior counts by wallet for profile stats
  private behaviorCounts: Map<string, Record<TradeBehavior, number>> = new Map();

  // Cleanup intervals
  private readonly TRADE_HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours (increased for STACK detection)
  private readonly PRICE_HISTORY_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

  /**
   * Classify a trade's behavior
   * Detection priority: SCOOP > LOCK > TAIL > EXIT > FLIP > ARB > SCALP > DCA > STACK > HEDGE > FADE > CHASE > STANDARD
   */
  classify(trade: WhaleTrade): BehaviorClassification {
    // Check behaviors in priority order
    const scoopResult = this.detectScoop(trade);
    if (scoopResult) return scoopResult;

    const lockResult = this.detectLock(trade);
    if (lockResult) return lockResult;

    const tailResult = this.detectTail(trade);
    if (tailResult) return tailResult;

    const exitResult = this.detectExit(trade);
    if (exitResult) return exitResult;

    const flipResult = this.detectFlip(trade);
    if (flipResult) return flipResult;

    const arbResult = this.detectArb(trade);
    if (arbResult) return arbResult;

    const scalpResult = this.detectScalp(trade);
    if (scalpResult) return scalpResult;

    const dcaResult = this.detectDCA(trade);
    if (dcaResult) return dcaResult;

    const stackResult = this.detectStack(trade);
    if (stackResult) return stackResult;

    const hedgeResult = this.detectHedge(trade);
    if (hedgeResult) return hedgeResult;

    const fadeResult = this.detectFade(trade);
    if (fadeResult) return fadeResult;

    const chaseResult = this.detectChase(trade);
    if (chaseResult) return chaseResult;

    // Default to STANDARD
    return {
      behavior: 'STANDARD',
      confidence: 'high',
      reasoning: 'Normal trade activity',
    };
  }

  /**
   * Record a trade after classification
   * Call this after classify() to update history for future classifications
   */
  recordTrade(trade: WhaleTrade): void {
    const key = this.getTradeKey(trade.whale.address, trade.marketId);
    const records = this.recentTrades.get(key) || [];

    records.push({
      trade,
      timestamp: Date.now(),
    });

    // Keep only recent trades
    const cutoff = Date.now() - this.TRADE_HISTORY_MAX_AGE_MS;
    const filtered = records.filter(r => r.timestamp >= cutoff);
    this.recentTrades.set(key, filtered);

    // Also update price history
    this.updatePriceHistory(trade.marketId, trade.price, trade.timestamp);

    // Track behavior counts
    if (trade.behavior) {
      this.trackBehavior(trade.whale.address, trade.behavior.behavior);
    }
  }

  /**
   * Track behavior count for a wallet
   */
  private trackBehavior(wallet: string, behavior: TradeBehavior): void {
    const walletKey = wallet.toLowerCase();
    let counts = this.behaviorCounts.get(walletKey);

    if (!counts) {
      counts = {
        SCOOP: 0, LOCK: 0, TAIL: 0,
        ARB: 0, SCALP: 0, HEDGE: 0, CHASE: 0,
        DCA: 0, STACK: 0, EXIT: 0, FLIP: 0, FADE: 0,
        STANDARD: 0,
      };
      this.behaviorCounts.set(walletKey, counts);
    }

    counts[behavior]++;
  }

  /**
   * Get behavior breakdown for a wallet
   */
  getBehaviorBreakdown(wallet: string): Record<TradeBehavior, number> {
    const walletKey = wallet.toLowerCase();
    return this.behaviorCounts.get(walletKey) || {
      SCOOP: 0, LOCK: 0, TAIL: 0,
      ARB: 0, SCALP: 0, HEDGE: 0, CHASE: 0,
      DCA: 0, STACK: 0, EXIT: 0, FLIP: 0, FADE: 0,
      STANDARD: 0,
    };
  }

  /**
   * Update price history for a market
   */
  updatePriceHistory(marketId: string, price: number, timestamp: number): void {
    const history = this.priceHistory.get(marketId) || [];

    history.push({ price, timestamp });

    // Keep only recent prices
    const cutoff = Date.now() - this.PRICE_HISTORY_MAX_AGE_MS;
    const filtered = history.filter(p => p.timestamp >= cutoff);
    this.priceHistory.set(marketId, filtered);
  }

  /**
   * SCOOP Detection
   * Buying at near-zero prices (<1%): scooping dust on resolved/dead markets
   */
  private detectScoop(trade: WhaleTrade): BehaviorClassification | null {
    if (trade.side !== 'BUY') return null;

    // BUY at 1% or less = scooping dust/dead shares
    if (trade.price <= BEHAVIOR_THRESHOLDS.SCOOP_LOW) {
      return {
        behavior: 'SCOOP',
        confidence: 'high',
        reasoning: `Buying ${trade.outcome} at ${(trade.price * 100).toFixed(1)}% - scooping dust`,
      };
    }

    return null;
  }

  /**
   * LOCK Detection
   * Buying near-certain outcomes: Buy YES at 97%+ or Buy NO at 97%+
   * This is locking in a winner on a resolved/certain market
   */
  private detectLock(trade: WhaleTrade): BehaviorClassification | null {
    if (trade.side !== 'BUY') return null;

    // BUY YES at 97%+ = locking in certain YES
    if (trade.outcome === 'YES' && trade.price >= BEHAVIOR_THRESHOLDS.TAIL_HIGH) {
      return {
        behavior: 'LOCK',
        confidence: 'high',
        reasoning: `Buying YES at ${(trade.price * 100).toFixed(0)}% - locking winner`,
      };
    }

    // BUY NO at 97%+ = locking in certain NO
    if (trade.outcome === 'NO' && trade.price >= BEHAVIOR_THRESHOLDS.TAIL_HIGH) {
      return {
        behavior: 'LOCK',
        confidence: 'high',
        reasoning: `Buying NO at ${(trade.price * 100).toFixed(0)}% - locking winner`,
      };
    }

    return null;
  }

  /**
   * TAIL Detection
   * Betting on unlikely outcomes: Buy YES at 3%- or Buy NO at 3%-
   */
  private detectTail(trade: WhaleTrade): BehaviorClassification | null {
    // BUY YES at 3%- = betting on unlikely YES
    if (trade.side === 'BUY' && trade.outcome === 'YES' && trade.price <= BEHAVIOR_THRESHOLDS.TAIL_LOW) {
      return {
        behavior: 'TAIL',
        confidence: 'high',
        reasoning: `Buying YES at ${(trade.price * 100).toFixed(0)}% - tail risk play`,
      };
    }

    // BUY NO at 3%- = betting on unlikely NO
    if (trade.side === 'BUY' && trade.outcome === 'NO' && trade.price <= BEHAVIOR_THRESHOLDS.TAIL_LOW) {
      return {
        behavior: 'TAIL',
        confidence: 'high',
        reasoning: `Buying NO at ${(trade.price * 100).toFixed(0)}% - tail risk play`,
      };
    }

    // SELL YES at 97%+ = selling likely winner (contrarian/exit)
    if (trade.side === 'SELL' && trade.outcome === 'YES' && trade.price >= BEHAVIOR_THRESHOLDS.TAIL_HIGH) {
      return {
        behavior: 'TAIL',
        confidence: 'high',
        reasoning: `Selling YES at ${(trade.price * 100).toFixed(0)}% - contrarian exit`,
      };
    }

    // SELL NO at 97%+ = selling likely winner (contrarian/exit)
    if (trade.side === 'SELL' && trade.outcome === 'NO' && trade.price >= BEHAVIOR_THRESHOLDS.TAIL_HIGH) {
      return {
        behavior: 'TAIL',
        confidence: 'high',
        reasoning: `Selling NO at ${(trade.price * 100).toFixed(0)}% - contrarian exit`,
      };
    }

    return null;
  }

  /**
   * ARB Detection
   * Buying both sides within 5 minutes for profitable redemption
   */
  private detectArb(trade: WhaleTrade): BehaviorClassification | null {
    if (trade.side !== 'BUY') return null;

    const key = this.getTradeKey(trade.whale.address, trade.marketId);
    const records = this.recentTrades.get(key) || [];
    const cutoff = Date.now() - BEHAVIOR_THRESHOLDS.ARB_WINDOW_MS;

    // Look for a BUY of opposite outcome within window
    const oppositeOutcome = trade.outcome === 'YES' ? 'NO' : 'YES';
    const recentOppositeBuy = records.find(r =>
      r.timestamp >= cutoff &&
      r.trade.side === 'BUY' &&
      r.trade.outcome === oppositeOutcome
    );

    if (recentOppositeBuy) {
      const timeDiff = Math.abs(trade.timestamp - recentOppositeBuy.trade.timestamp);
      const minutes = Math.round(timeDiff / 60000);
      return {
        behavior: 'ARB',
        confidence: 'high',
        reasoning: `Bought both YES and NO within ${minutes}m - redemption arb`,
      };
    }

    return null;
  }

  /**
   * SCALP Detection
   * Exit within 1 hour of entry (short-term flip)
   */
  private detectScalp(trade: WhaleTrade): BehaviorClassification | null {
    if (trade.side !== 'SELL') return null;

    const key = this.getTradeKey(trade.whale.address, trade.marketId);
    const records = this.recentTrades.get(key) || [];
    const cutoff = Date.now() - BEHAVIOR_THRESHOLDS.SCALP_WINDOW_MS;

    // Look for a BUY of same outcome within window
    const recentBuy = records.find(r =>
      r.timestamp >= cutoff &&
      r.trade.side === 'BUY' &&
      r.trade.outcome === trade.outcome
    );

    if (recentBuy) {
      const holdTimeMs = trade.timestamp - recentBuy.trade.timestamp;
      const holdMins = Math.round(holdTimeMs / 60000);
      const entryPrice = recentBuy.trade.price;
      const exitPrice = trade.price;
      const pnlPct = ((exitPrice - entryPrice) / entryPrice * 100).toFixed(1);
      const direction = exitPrice > entryPrice ? '+' : '';

      return {
        behavior: 'SCALP',
        confidence: holdMins < 30 ? 'high' : 'medium',
        reasoning: `Exit after ${holdMins}m hold (${direction}${pnlPct}%)`,
      };
    }

    return null;
  }

  /**
   * HEDGE Detection
   * Buying opposite of prior position (risk reduction)
   */
  private detectHedge(trade: WhaleTrade): BehaviorClassification | null {
    const key = this.getTradeKey(trade.whale.address, trade.marketId);
    const records = this.recentTrades.get(key) || [];

    if (records.length === 0) return null;

    // Check if they have a position in opposite outcome
    const oppositeOutcome = trade.outcome === 'YES' ? 'NO' : 'YES';

    // Calculate net position in opposite outcome
    let oppositeNetShares = 0;
    for (const record of records) {
      if (record.trade.outcome === oppositeOutcome) {
        if (record.trade.side === 'BUY') {
          oppositeNetShares += record.trade.size;
        } else {
          oppositeNetShares -= record.trade.size;
        }
      }
    }

    // If they have positive position in opposite outcome and are now buying this outcome
    if (oppositeNetShares > 0 && trade.side === 'BUY') {
      const hedgeRatio = trade.size / oppositeNetShares;
      if (hedgeRatio >= 0.1) { // At least 10% hedge
        return {
          behavior: 'HEDGE',
          confidence: hedgeRatio >= 0.5 ? 'high' : 'medium',
          reasoning: `Hedging ${(hedgeRatio * 100).toFixed(0)}% of opposite position`,
        };
      }
    }

    // Also check if they're reducing their own position significantly
    let sameNetShares = 0;
    for (const record of records) {
      if (record.trade.outcome === trade.outcome) {
        if (record.trade.side === 'BUY') {
          sameNetShares += record.trade.size;
        } else {
          sameNetShares -= record.trade.size;
        }
      }
    }

    // If selling and reducing position by 25%+
    if (trade.side === 'SELL' && sameNetShares > 0) {
      const reductionRatio = trade.size / sameNetShares;
      if (reductionRatio >= BEHAVIOR_THRESHOLDS.HEDGE_MIN_REDUCTION) {
        return {
          behavior: 'HEDGE',
          confidence: reductionRatio >= 0.5 ? 'high' : 'medium',
          reasoning: `Reducing position by ${(reductionRatio * 100).toFixed(0)}%`,
        };
      }
    }

    return null;
  }

  /**
   * CHASE Detection
   * Entry after 5%+ move in same direction (momentum following)
   */
  private detectChase(trade: WhaleTrade): BehaviorClassification | null {
    if (trade.side !== 'BUY') return null;

    const history = this.priceHistory.get(trade.marketId) || [];
    if (history.length < 2) return null;

    const cutoff = Date.now() - BEHAVIOR_THRESHOLDS.CHASE_LOOKBACK_MS;
    const recentHistory = history.filter(p => p.timestamp >= cutoff);

    if (recentHistory.length < 2) return null;

    // Get oldest price in window
    const oldestPrice = recentHistory[0].price;
    const currentPrice = trade.price;
    const priceMove = currentPrice - oldestPrice;
    const priceMoveAbs = Math.abs(priceMove);

    if (priceMoveAbs < BEHAVIOR_THRESHOLDS.CHASE_THRESHOLD) return null;

    // BUY YES after price went UP = chasing momentum
    if (trade.outcome === 'YES' && priceMove > 0) {
      return {
        behavior: 'CHASE',
        confidence: priceMoveAbs >= 0.10 ? 'high' : 'medium',
        reasoning: `Buying after ${(priceMove * 100).toFixed(0)}% up move`,
      };
    }

    // BUY NO after price went DOWN = chasing momentum (NO becomes more valuable as YES drops)
    if (trade.outcome === 'NO' && priceMove < 0) {
      return {
        behavior: 'CHASE',
        confidence: priceMoveAbs >= 0.10 ? 'high' : 'medium',
        reasoning: `Buying NO after ${(Math.abs(priceMove) * 100).toFixed(0)}% down move`,
      };
    }

    return null;
  }

  /**
   * EXIT Detection
   * Selling 80%+ of tracked position
   */
  private detectExit(trade: WhaleTrade): BehaviorClassification | null {
    if (trade.side !== 'SELL') return null;

    const key = this.getTradeKey(trade.whale.address, trade.marketId);
    const records = this.recentTrades.get(key) || [];

    if (records.length === 0) return null;

    // Calculate total position in this outcome
    let totalPosition = 0;
    for (const record of records) {
      if (record.trade.outcome === trade.outcome) {
        if (record.trade.side === 'BUY') {
          totalPosition += record.trade.size;
        } else {
          totalPosition -= record.trade.size;
        }
      }
    }

    // Only detect EXIT if they had a meaningful position
    if (totalPosition <= 0) return null;

    const reductionRatio = trade.size / totalPosition;
    if (reductionRatio >= BEHAVIOR_THRESHOLDS.EXIT_REDUCTION) {
      return {
        behavior: 'EXIT',
        confidence: reductionRatio >= 0.95 ? 'high' : 'medium',
        reasoning: `Exiting ${(reductionRatio * 100).toFixed(0)}% of position`,
      };
    }

    return null;
  }

  /**
   * FLIP Detection
   * Selling one outcome then buying opposite within 30 minutes
   */
  private detectFlip(trade: WhaleTrade): BehaviorClassification | null {
    if (trade.side !== 'BUY') return null;

    const key = this.getTradeKey(trade.whale.address, trade.marketId);
    const records = this.recentTrades.get(key) || [];
    const cutoff = Date.now() - BEHAVIOR_THRESHOLDS.FLIP_WINDOW_MS;

    // Look for a SELL of opposite outcome within window
    const oppositeOutcome = trade.outcome === 'YES' ? 'NO' : 'YES';
    const recentOppositeSell = records.find(r =>
      r.timestamp >= cutoff &&
      r.trade.side === 'SELL' &&
      r.trade.outcome === oppositeOutcome
    );

    if (recentOppositeSell) {
      const timeDiff = Math.abs(trade.timestamp - recentOppositeSell.trade.timestamp);
      const minutes = Math.round(timeDiff / 60000);
      return {
        behavior: 'FLIP',
        confidence: 'high',
        reasoning: `Flipped from ${oppositeOutcome} to ${trade.outcome} in ${minutes}m`,
      };
    }

    return null;
  }

  /**
   * DCA Detection
   * Multiple buys at similar price (±5%) over 2+ hours within 4hr window
   */
  private detectDCA(trade: WhaleTrade): BehaviorClassification | null {
    if (trade.side !== 'BUY') return null;

    const key = this.getTradeKey(trade.whale.address, trade.marketId);
    const records = this.recentTrades.get(key) || [];
    const cutoff = Date.now() - BEHAVIOR_THRESHOLDS.DCA_WINDOW_MS;

    // Find recent BUYs of same outcome within price tolerance
    const similarBuys = records.filter(r =>
      r.timestamp >= cutoff &&
      r.trade.side === 'BUY' &&
      r.trade.outcome === trade.outcome &&
      Math.abs(r.trade.price - trade.price) / trade.price <= BEHAVIOR_THRESHOLDS.DCA_PRICE_TOLERANCE
    );

    // Need 3+ trades including current one
    if (similarBuys.length >= BEHAVIOR_THRESHOLDS.DCA_MIN_TRADES - 1) {
      // Check time spread - should be at least 2 hours between first and current
      const timestamps = similarBuys.map(r => r.trade.timestamp);
      const oldest = Math.min(...timestamps);
      const timeSpread = trade.timestamp - oldest;

      if (timeSpread >= 2 * 60 * 60 * 1000) { // 2 hours
        const avgPrice = (similarBuys.reduce((s, r) => s + r.trade.price, 0) + trade.price) / (similarBuys.length + 1);
        return {
          behavior: 'DCA',
          confidence: similarBuys.length >= 4 ? 'high' : 'medium',
          reasoning: `${similarBuys.length + 1} buys at avg ${(avgPrice * 100).toFixed(0)}%`,
        };
      }
    }

    return null;
  }

  /**
   * STACK Detection
   * Building position across 3+ trades in 24hrs with total > $1000
   */
  private detectStack(trade: WhaleTrade): BehaviorClassification | null {
    if (trade.side !== 'BUY') return null;

    const key = this.getTradeKey(trade.whale.address, trade.marketId);
    const records = this.recentTrades.get(key) || [];
    const cutoff = Date.now() - BEHAVIOR_THRESHOLDS.STACK_WINDOW_MS;

    // Find recent BUYs of same outcome
    const recentBuys = records.filter(r =>
      r.timestamp >= cutoff &&
      r.trade.side === 'BUY' &&
      r.trade.outcome === trade.outcome
    );

    // Need 3+ trades including current one
    if (recentBuys.length >= BEHAVIOR_THRESHOLDS.STACK_MIN_TRADES - 1) {
      const totalSize = recentBuys.reduce((s, r) => s + r.trade.sizeUsdc, 0) + trade.sizeUsdc;

      if (totalSize >= BEHAVIOR_THRESHOLDS.STACK_MIN_TOTAL) {
        const sizeStr = totalSize >= 1000 ? `$${(totalSize / 1000).toFixed(1)}K` : `$${totalSize.toFixed(0)}`;
        return {
          behavior: 'STACK',
          confidence: recentBuys.length >= 4 || totalSize >= 5000 ? 'high' : 'medium',
          reasoning: `Building ${trade.outcome} position: ${recentBuys.length + 1} trades, ${sizeStr}`,
        };
      }
    }

    return null;
  }

  /**
   * FADE Detection
   * Buying against recent trend (contrarian)
   */
  private detectFade(trade: WhaleTrade): BehaviorClassification | null {
    if (trade.side !== 'BUY') return null;

    const history = this.priceHistory.get(trade.marketId) || [];
    if (history.length < 2) return null;

    const cutoff = Date.now() - BEHAVIOR_THRESHOLDS.CHASE_LOOKBACK_MS;
    const recentHistory = history.filter(p => p.timestamp >= cutoff);

    if (recentHistory.length < 2) return null;

    // Get oldest price in window
    const oldestPrice = recentHistory[0].price;
    const currentPrice = trade.price;
    const priceMove = currentPrice - oldestPrice;
    const priceMoveAbs = Math.abs(priceMove);

    if (priceMoveAbs < BEHAVIOR_THRESHOLDS.FADE_THRESHOLD) return null;

    // BUY YES after price went DOWN = fading the downtrend (contrarian)
    if (trade.outcome === 'YES' && priceMove < 0) {
      return {
        behavior: 'FADE',
        confidence: priceMoveAbs >= 0.10 ? 'high' : 'medium',
        reasoning: `Buying YES after ${(Math.abs(priceMove) * 100).toFixed(0)}% down - contrarian`,
      };
    }

    // BUY NO after price went UP = fading the uptrend (contrarian)
    if (trade.outcome === 'NO' && priceMove > 0) {
      return {
        behavior: 'FADE',
        confidence: priceMoveAbs >= 0.10 ? 'high' : 'medium',
        reasoning: `Buying NO after ${(priceMove * 100).toFixed(0)}% up - contrarian`,
      };
    }

    return null;
  }

  /**
   * Get trade history key
   */
  private getTradeKey(wallet: string, marketId: string): string {
    return `${wallet.toLowerCase()}:${marketId}`;
  }

  /**
   * Cleanup old data periodically
   */
  cleanup(): void {
    const tradeCutoff = Date.now() - this.TRADE_HISTORY_MAX_AGE_MS;
    const priceCutoff = Date.now() - this.PRICE_HISTORY_MAX_AGE_MS;

    // Cleanup trade history
    for (const [key, records] of this.recentTrades.entries()) {
      const filtered = records.filter(r => r.timestamp >= tradeCutoff);
      if (filtered.length === 0) {
        this.recentTrades.delete(key);
      } else {
        this.recentTrades.set(key, filtered);
      }
    }

    // Cleanup price history
    for (const [marketId, history] of this.priceHistory.entries()) {
      const filtered = history.filter(p => p.timestamp >= priceCutoff);
      if (filtered.length === 0) {
        this.priceHistory.delete(marketId);
      } else {
        this.priceHistory.set(marketId, filtered);
      }
    }
  }

  /**
   * Get stats for debugging
   */
  getStats(): { trackedWalletMarkets: number; priceHistoryMarkets: number } {
    return {
      trackedWalletMarkets: this.recentTrades.size,
      priceHistoryMarkets: this.priceHistory.size,
    };
  }
}

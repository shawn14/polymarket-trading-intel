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

import type { WhaleTrade, BehaviorClassification } from './types.js';

// Configurable thresholds
export const BEHAVIOR_THRESHOLDS = {
  TAIL_HIGH: 0.97,           // 97% - extreme high price for TAIL detection
  TAIL_LOW: 0.03,            // 3% - extreme low price for TAIL detection
  ARB_WINDOW_MS: 300000,     // 5 minutes - window for ARB detection
  SCALP_WINDOW_MS: 3600000,  // 1 hour - window for SCALP detection
  HEDGE_MIN_REDUCTION: 0.25, // 25% - minimum position reduction for HEDGE
  CHASE_THRESHOLD: 0.05,     // 5% - minimum price move for CHASE detection
  CHASE_LOOKBACK_MS: 1800000, // 30 minutes - lookback window for CHASE
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

  // Cleanup intervals
  private readonly TRADE_HISTORY_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
  private readonly PRICE_HISTORY_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

  /**
   * Classify a trade's behavior
   * Detection priority: TAIL > ARB > SCALP > HEDGE > CHASE > STANDARD
   */
  classify(trade: WhaleTrade): BehaviorClassification {
    // Check behaviors in priority order
    const tailResult = this.detectTail(trade);
    if (tailResult) return tailResult;

    const arbResult = this.detectArb(trade);
    if (arbResult) return arbResult;

    const scalpResult = this.detectScalp(trade);
    if (scalpResult) return scalpResult;

    const hedgeResult = this.detectHedge(trade);
    if (hedgeResult) return hedgeResult;

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
   * TAIL Detection
   * Extreme conviction bets: Sell NO at 97%+ or Buy YES at 3%-
   */
  private detectTail(trade: WhaleTrade): BehaviorClassification | null {
    // SELL NO at 97%+ = betting market resolves YES (tail bet on YES)
    if (trade.side === 'SELL' && trade.outcome === 'NO' && trade.price >= BEHAVIOR_THRESHOLDS.TAIL_HIGH) {
      return {
        behavior: 'TAIL',
        confidence: 'high',
        reasoning: `Selling NO at ${(trade.price * 100).toFixed(0)}% - extreme conviction YES`,
      };
    }

    // BUY YES at 3%- = extreme cheap entry on unlikely outcome
    if (trade.side === 'BUY' && trade.outcome === 'YES' && trade.price <= BEHAVIOR_THRESHOLDS.TAIL_LOW) {
      return {
        behavior: 'TAIL',
        confidence: 'high',
        reasoning: `Buying YES at ${(trade.price * 100).toFixed(0)}% - tail risk play`,
      };
    }

    // BUY NO at 97%+ = betting market resolves NO (tail bet on NO)
    if (trade.side === 'BUY' && trade.outcome === 'NO' && trade.price >= BEHAVIOR_THRESHOLDS.TAIL_HIGH) {
      return {
        behavior: 'TAIL',
        confidence: 'high',
        reasoning: `Buying NO at ${(trade.price * 100).toFixed(0)}% - extreme conviction NO`,
      };
    }

    // SELL YES at 3%- = extreme cheap entry via selling
    if (trade.side === 'SELL' && trade.outcome === 'YES' && trade.price <= BEHAVIOR_THRESHOLDS.TAIL_LOW) {
      return {
        behavior: 'TAIL',
        confidence: 'high',
        reasoning: `Selling YES at ${(trade.price * 100).toFixed(0)}% - tail risk exit`,
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

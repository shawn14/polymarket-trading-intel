/**
 * Position Ledger
 *
 * Tracks net positions per wallet/market/outcome for exit detection.
 * Maintains VWAP entry prices and peak position sizes.
 */

import type { Position, WhaleTrade, StoredTrade } from './types.js';

export class PositionLedger {
  // Key format: wallet:marketId:outcome
  private positions: Map<string, Position> = new Map();

  /**
   * Generate position key
   */
  private key(wallet: string, marketId: string, outcome: 'YES' | 'NO'): string {
    return `${wallet.toLowerCase()}:${marketId}:${outcome}`;
  }

  /**
   * Get or create a position
   */
  private getOrCreate(wallet: string, marketId: string, outcome: 'YES' | 'NO'): Position {
    const k = this.key(wallet, marketId, outcome);
    let pos = this.positions.get(k);
    if (!pos) {
      pos = {
        wallet: wallet.toLowerCase(),
        marketId,
        outcome,
        netShares: 0,
        vwapEntry: 0,
        realizedPnl: 0,
        peakShares: 0,
        updatedAt: Date.now(),
      };
      this.positions.set(k, pos);
    }
    return pos;
  }

  /**
   * Process a trade and update positions
   */
  onTrade(trade: WhaleTrade | StoredTrade, wallet: string): void {
    const outcome = 'outcome' in trade ? trade.outcome : this.inferOutcome(trade);
    if (!outcome) return;

    const pos = this.getOrCreate(wallet, trade.marketId, outcome);
    const shares = 'size' in trade ? trade.size : 0;
    const price = trade.price;

    // Determine if this wallet is buying or selling
    const isBuyer = this.isBuyer(trade, wallet);

    if (isBuyer) {
      // Buying: increase position, update VWAP
      if (pos.netShares >= 0) {
        // Adding to long position - update VWAP
        const totalValue = pos.vwapEntry * pos.netShares + price * shares;
        const newShares = pos.netShares + shares;
        pos.vwapEntry = newShares > 0 ? totalValue / newShares : price;
        pos.netShares = newShares;
      } else {
        // Covering short position
        const coverShares = Math.min(shares, Math.abs(pos.netShares));
        pos.realizedPnl += (pos.vwapEntry - price) * coverShares; // Short PnL
        pos.netShares += shares;

        // If we crossed to long, reset VWAP
        if (pos.netShares > 0) {
          pos.vwapEntry = price;
        }
      }
    } else {
      // Selling: decrease position, realize PnL
      if (pos.netShares > 0) {
        // Closing long position
        const closeShares = Math.min(shares, pos.netShares);
        pos.realizedPnl += (price - pos.vwapEntry) * closeShares; // Long PnL
        pos.netShares -= shares;

        // If we crossed to short, set new VWAP
        if (pos.netShares < 0) {
          pos.vwapEntry = price;
        }
      } else {
        // Adding to short position - update VWAP
        const totalValue = pos.vwapEntry * Math.abs(pos.netShares) + price * shares;
        pos.netShares -= shares;
        pos.vwapEntry = Math.abs(pos.netShares) > 0
          ? totalValue / Math.abs(pos.netShares)
          : price;
      }
    }

    // Track peak position for exit detection
    const absShares = Math.abs(pos.netShares);
    if (absShares > pos.peakShares) {
      pos.peakShares = absShares;
    }

    pos.updatedAt = Date.now();
  }

  /**
   * Determine if wallet is buyer in this trade
   */
  private isBuyer(trade: WhaleTrade | StoredTrade, wallet: string): boolean {
    const walletLower = wallet.toLowerCase();

    if ('isMaker' in trade) {
      // WhaleTrade - use whale info
      if (trade.side === 'BUY') {
        return !trade.isMaker; // Taker of a buy order is the buyer
      } else {
        return trade.isMaker; // Maker of a sell order is the seller (so other side buys)
      }
    }

    // StoredTrade - check maker/taker
    const makerLower = ('maker' in trade ? trade.maker : '').toLowerCase();
    const takerLower = ('taker' in trade ? trade.taker : '').toLowerCase();

    if (trade.side === 'BUY') {
      return takerLower === walletLower;
    } else {
      return makerLower === walletLower;
    }
  }

  /**
   * Infer outcome from StoredTrade (if not explicit)
   */
  private inferOutcome(trade: StoredTrade): 'YES' | 'NO' | null {
    if ('outcome' in trade && trade.outcome) {
      return trade.outcome as 'YES' | 'NO';
    }
    // Default assumption: first token is YES
    return 'YES';
  }

  /**
   * Get position for a wallet/market/outcome
   */
  getPosition(wallet: string, marketId: string, outcome: 'YES' | 'NO'): Position | null {
    return this.positions.get(this.key(wallet, marketId, outcome)) || null;
  }

  /**
   * Get all positions for a wallet
   */
  getWalletPositions(wallet: string): Position[] {
    const walletLower = wallet.toLowerCase();
    const result: Position[] = [];
    for (const pos of this.positions.values()) {
      if (pos.wallet === walletLower && pos.netShares !== 0) {
        result.push(pos);
      }
    }
    return result;
  }

  /**
   * Get all positions for a market
   */
  getMarketPositions(marketId: string): Position[] {
    const result: Position[] = [];
    for (const pos of this.positions.values()) {
      if (pos.marketId === marketId && pos.netShares !== 0) {
        result.push(pos);
      }
    }
    return result;
  }

  /**
   * Calculate position reduction from peak
   * Returns 0-1 (0 = no reduction, 1 = fully exited)
   */
  getPositionReduction(wallet: string, marketId: string, outcome: 'YES' | 'NO'): number {
    const pos = this.getPosition(wallet, marketId, outcome);
    if (!pos || pos.peakShares === 0) return 0;

    const currentAbs = Math.abs(pos.netShares);
    const reduction = 1 - (currentAbs / pos.peakShares);

    return Math.max(0, Math.min(1, reduction));
  }

  /**
   * Check if wallet has significantly reduced position
   * Returns true if reduction >= threshold (default 50%)
   */
  hasSignificantReduction(
    wallet: string,
    marketId: string,
    outcome: 'YES' | 'NO',
    threshold: number = 0.5
  ): boolean {
    return this.getPositionReduction(wallet, marketId, outcome) >= threshold;
  }

  /**
   * Get position value in USDC
   */
  getPositionValue(wallet: string, marketId: string, outcome: 'YES' | 'NO', currentPrice: number): number {
    const pos = this.getPosition(wallet, marketId, outcome);
    if (!pos) return 0;

    // Value = shares * current price (for YES), or shares * (1 - current price) for NO
    return pos.netShares * currentPrice;
  }

  /**
   * Get unrealized PnL
   */
  getUnrealizedPnL(wallet: string, marketId: string, outcome: 'YES' | 'NO', currentPrice: number): number {
    const pos = this.getPosition(wallet, marketId, outcome);
    if (!pos || pos.netShares === 0) return 0;

    if (pos.netShares > 0) {
      // Long position
      return (currentPrice - pos.vwapEntry) * pos.netShares;
    } else {
      // Short position
      return (pos.vwapEntry - currentPrice) * Math.abs(pos.netShares);
    }
  }

  /**
   * Get total realized PnL for wallet
   */
  getTotalRealizedPnL(wallet: string): number {
    const walletLower = wallet.toLowerCase();
    let total = 0;
    for (const pos of this.positions.values()) {
      if (pos.wallet === walletLower) {
        total += pos.realizedPnl;
      }
    }
    return total;
  }

  /**
   * Clean up old positions with zero shares
   */
  cleanup(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24 hours

    for (const [key, pos] of this.positions) {
      // Remove positions that are zero AND haven't been updated recently
      if (pos.netShares === 0 && pos.updatedAt < cutoff) {
        this.positions.delete(key);
      }
    }
  }

  /**
   * Get stats for debugging
   */
  getStats(): { totalPositions: number; activePositions: number } {
    let active = 0;
    for (const pos of this.positions.values()) {
      if (pos.netShares !== 0) active++;
    }
    return {
      totalPositions: this.positions.size,
      activePositions: active,
    };
  }
}

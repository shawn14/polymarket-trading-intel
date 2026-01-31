/**
 * Trade Recorder
 *
 * Bridge between whale tracking system and the trade database.
 * Converts WhaleTrade events to RawTrade records and stores them.
 */

import { getTradeDatabase, type RawTrade, type TradeDatabase } from './index.js';
import type { WhaleTrade } from '../ingestion/whales/types.js';

export interface MarketPriceProvider {
  getMarketMid(marketId: string): number | undefined;
}

export class TradeRecorder {
  private db: TradeDatabase;
  private priceProvider: MarketPriceProvider;
  private tradeCount = 0;

  constructor(priceProvider: MarketPriceProvider) {
    this.db = getTradeDatabase();
    this.priceProvider = priceProvider;
  }

  /**
   * Record a whale trade to the database
   */
  recordWhaleTrade(trade: WhaleTrade): void {
    // Get current mid price for impact reference
    const mid = this.priceProvider.getMarketMid(trade.marketId) ?? trade.price;

    const rawTrade: RawTrade = {
      trade_id: this.generateTradeId(trade),
      venue: 'polymarket',
      market_id: trade.marketId,
      trader_id: trade.whale.address.toLowerCase(),
      side: trade.side,
      outcome: trade.outcome,
      price_cents: Math.round(trade.price * 100),
      size: Math.round(trade.size),
      notional_cents: Math.round(trade.sizeUsdc * 100),
      mid_at_trade_cents: Math.round(mid * 100),
      ts: trade.timestamp,
    };

    this.db.insertTrade(rawTrade);
    this.tradeCount++;

    // Also update the snapshot with volume/flow
    this.updateSnapshotWithTrade(trade);
  }

  /**
   * Update minute snapshot with trade volume and flow
   */
  private updateSnapshotWithTrade(trade: WhaleTrade): void {
    const minuteTs = Math.floor(trade.timestamp / 60000) * 60000;
    const mid = this.priceProvider.getMarketMid(trade.marketId) ?? trade.price;
    const notionalCents = Math.round(trade.sizeUsdc * 100);

    // Net flow: positive for YES buys, negative for NO buys (or YES sells)
    const flowDirection =
      (trade.side === 'BUY' && trade.outcome === 'YES') ||
      (trade.side === 'SELL' && trade.outcome === 'NO')
        ? 1
        : -1;

    this.db.upsertSnapshot({
      market_id: trade.marketId,
      minute_ts: minuteTs,
      mid_cents: Math.round(mid * 100),
      bid_cents: 0,
      ask_cents: 0,
      spread_cents: 0,
      vol_cents_1m: notionalCents,
      net_flow_cents_1m: notionalCents * flowDirection,
    });
  }

  /**
   * Generate unique trade ID
   */
  private generateTradeId(trade: WhaleTrade): string {
    return `${trade.marketId}-${trade.whale.address.slice(2, 10)}-${trade.timestamp}-${this.tradeCount}`;
  }

  /**
   * Get impact badge for a trade (after impact is computed)
   */
  getImpactBadge(tradeId: string): 'MOVED_MARKET' | 'NO_IMPACT' | null {
    return this.db.getImpactBadge(tradeId);
  }

  /**
   * Get impact badge by trade properties (for API)
   */
  getImpactBadgeByProps(
    traderId: string,
    marketId: string,
    timestamp: number
  ): 'MOVED_MARKET' | 'NO_IMPACT' | null {
    return this.db.getImpactBadgeByProps(traderId, marketId, timestamp);
  }

  /**
   * Get trader impact statistics
   */
  getTraderImpactStats(traderId: string, days = 7) {
    return this.db.getTraderImpactStats(traderId, days);
  }

  /**
   * Get market net flow
   */
  getMarketNetFlow(marketId: string, minutes = 10) {
    return this.db.getMarketNetFlow(marketId, minutes);
  }

  /**
   * Get paginated trades from database
   */
  getTrades(options: {
    limit?: number;
    offset?: number;
    traderId?: string;
    marketId?: string;
  } = {}) {
    return this.db.getTrades(options);
  }

  /**
   * Get stats
   */
  getStats(): { tradeCount: number; dbStats: ReturnType<TradeDatabase['getStats']> } {
    return {
      tradeCount: this.tradeCount,
      dbStats: this.db.getStats(),
    };
  }
}

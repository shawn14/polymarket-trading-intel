/**
 * Kalshi Ingestion Module
 *
 * Provides market data from Kalshi prediction market.
 */

export { KalshiClient } from './client.js';
export type {
  KalshiClientOptions,
  KalshiClientEvents,
} from './client.js';
export type {
  KalshiMarket,
  KalshiMarketView,
  KalshiSortType,
} from './types.js';

/**
 * Kalshi API Types
 */

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  subtitle?: string;
  status: 'unopened' | 'open' | 'paused' | 'closed' | 'settled';
  yes_bid: number;  // in cents (0-100)
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  previous_yes_bid?: number;
  previous_yes_ask?: number;
  previous_price?: number;
  volume: number;
  volume_24h: number;
  liquidity: number;
  open_interest: number;
  open_time?: string;
  close_time?: string;
  expiration_time?: string;
  result?: 'yes' | 'no' | 'all_yes' | 'all_no';
  created_time?: string;
  category?: string;
  series_ticker?: string;
}

export interface KalshiMarketsResponse {
  markets: KalshiMarket[];
  cursor?: string;
}

export interface KalshiMarketView {
  ticker: string;
  eventTicker: string;
  title: string;
  subtitle?: string;
  yesPrice: number;  // 0-1 (normalized from cents)
  noPrice: number;
  lastPrice: number;
  priceChange24h: number;  // Percentage points change
  volume24h: number;
  totalVolume: number;
  liquidity: number;
  openInterest: number;
  closeTime?: string;
  category?: string;
  url: string;
}

export type KalshiSortType = 'movers' | 'trending' | 'newest' | 'volume';

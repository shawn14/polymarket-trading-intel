/**
 * Polymarket WebSocket Types
 */

// Order book entry
export interface OrderSummary {
  price: string;
  size: string;
}

// Book snapshot message
export interface BookMessage {
  event_type: 'book';
  asset_id: string;
  market: string; // condition ID
  timestamp: number;
  hash: string;
  buys: OrderSummary[];
  sells: OrderSummary[];
}

// Price change message
export interface PriceChangeMessage {
  event_type: 'price_change';
  market: string;
  timestamp: number;
  price_changes: Array<{
    asset_id: string;
    price: string;
    size: string;
    side: 'BUY' | 'SELL';
    hash: string;
    best_bid: string;
    best_ask: string;
  }>;
}

// Last trade price message
export interface LastTradePriceMessage {
  event_type: 'last_trade_price';
  asset_id: string;
  market: string;
  price: string;
  side: 'BUY' | 'SELL';
  size: string;
  fee_rate: string;
  timestamp: number;
}

// Best bid/ask message
export interface BestBidAskMessage {
  event_type: 'best_bid_ask';
  asset_id: string;
  market: string;
  best_bid: string;
  best_ask: string;
  spread: string;
  timestamp: number;
}

// Tick size change message
export interface TickSizeChangeMessage {
  event_type: 'tick_size_change';
  asset_id: string;
  market: string;
  old_tick_size: string;
  new_tick_size: string;
  side: 'BUY' | 'SELL';
  timestamp: number;
}

// New market message
export interface NewMarketMessage {
  event_type: 'new_market';
  market: string;
  asset_id: string;
  timestamp: number;
}

// Market resolved message
export interface MarketResolvedMessage {
  event_type: 'market_resolved';
  market: string;
  asset_id: string;
  winner: boolean;
  timestamp: number;
}

// Union of all CLOB market channel messages
export type MarketChannelMessage =
  | BookMessage
  | PriceChangeMessage
  | LastTradePriceMessage
  | BestBidAskMessage
  | TickSizeChangeMessage
  | NewMarketMessage
  | MarketResolvedMessage;

// RTDS message types
export interface TradeMessage {
  topic: 'activity';
  type: 'trades';
  payload: {
    asset: string;
    condition_id: string;
    price: string;
    side: 'BUY' | 'SELL';
    size: string;
    timestamp: number;
    user_pseudonym?: string;
  };
}

export interface OrdersMatchedMessage {
  topic: 'activity';
  type: 'orders_matched';
  payload: {
    asset: string;
    condition_id: string;
    price: string;
    size: string;
    timestamp: number;
  };
}

export interface CryptoPriceMessage {
  topic: 'crypto_prices';
  type: 'update';
  payload: {
    symbol: string;
    price: number;
    timestamp: number;
  };
}

export type RTDSMessage = TradeMessage | OrdersMatchedMessage | CryptoPriceMessage;

// Subscription request for CLOB WebSocket
export interface ClobSubscription {
  type: 'MARKET' | 'USER';
  assets_ids?: string[];
  markets?: string[];
}

// Subscription request for RTDS
export interface RTDSSubscription {
  topic: string;
  type: string;
  filters?: string;
}

// Market data for REST API (Gamma API format)
export interface Market {
  id: string;
  conditionId: string;
  slug: string;
  question: string;
  description: string;
  outcomes: string; // JSON string: '["Yes", "No"]'
  outcomePrices: string; // JSON string: '["0.55", "0.45"]'
  clobTokenIds: string; // JSON string: '["token1", "token2"]'
  volume: string;
  volumeNum: number;
  liquidity: string;
  liquidityNum: number;
  endDate: string;
  endDateIso: string;
  active: boolean;
  closed: boolean;
  resolved?: boolean;
  acceptingOrders?: boolean;
  enableOrderBook: boolean;
}

// Parsed market with typed arrays
export interface ParsedMarket {
  id: string;
  conditionId: string;
  slug: string;
  question: string;
  description: string;
  outcomes: string[];
  outcomePrices: number[];
  tokenIds: string[];
  volume: number;
  liquidity: number;
  endDate: string;
  active: boolean;
  closed: boolean;
}

// Event grouping markets
export interface Event {
  id: string;
  slug: string;
  title: string;
  description: string;
  markets: Market[];
}

// Helper to parse Market into ParsedMarket
export function parseMarket(market: Market): ParsedMarket {
  const parseJsonArray = <T>(str: string | undefined): T[] => {
    if (!str) return [];
    try {
      return JSON.parse(str) as T[];
    } catch {
      return [];
    }
  };

  return {
    id: market.id,
    conditionId: market.conditionId,
    slug: market.slug,
    question: market.question,
    description: market.description,
    outcomes: parseJsonArray<string>(market.outcomes),
    outcomePrices: parseJsonArray<string>(market.outcomePrices).map(Number),
    tokenIds: parseJsonArray<string>(market.clobTokenIds),
    volume: market.volumeNum ?? parseFloat(market.volume) ?? 0,
    liquidity: market.liquidityNum ?? parseFloat(market.liquidity) ?? 0,
    endDate: market.endDateIso ?? market.endDate,
    active: market.active,
    closed: market.closed,
  };
}

// Internal order book representation
export interface OrderBook {
  assetId: string;
  market: string;
  timestamp: number;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  bestBid: number;
  bestAsk: number;
  spread: number;
  midpoint: number;
}

// Price update event emitted by client
export interface PriceUpdate {
  assetId: string;
  market: string;
  price: number;
  side: 'BUY' | 'SELL';
  size: number;
  bestBid: number;
  bestAsk: number;
  timestamp: number;
}

// Trade event emitted by client
export interface Trade {
  assetId: string;
  market: string;
  price: number;
  side: 'BUY' | 'SELL';
  size: number;
  timestamp: number;
}

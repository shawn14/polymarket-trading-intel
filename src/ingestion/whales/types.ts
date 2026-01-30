/**
 * Whale Intelligence Types
 *
 * Type definitions for whale tracking, position management, and edge detection.
 */

// Whale tier classification
export type WhaleTier = 'top10' | 'top50' | 'tracked';

// Whale information
export interface WhaleInfo {
  address: string;
  name?: string;           // Leaderboard display name (optional enrichment)
  pnl7d: number;           // P&L last 7 days (USDC)
  pnl30d: number;          // P&L last 30 days (USDC)
  volume7d: number;        // Volume last 7 days (USDC)
  volume30d: number;       // Volume last 30 days (USDC)
  tradeCount7d: number;    // Number of trades (7d)
  tradeCount30d: number;   // Number of trades (30d)
  earlyEntryScore: number; // How often they're early (0-100)
  copySuitability: number; // Copy suitability score (0-100)
  tier: WhaleTier;
  lastSeen: number;        // Last trade timestamp
}

// Stored trade record
export interface StoredTrade {
  id: string;              // Unique trade ID
  marketId: string;        // Condition ID
  assetId: string;         // Token ID
  maker: string;           // Maker wallet address
  taker: string;           // Taker wallet address
  side: 'BUY' | 'SELL';    // Trade direction
  outcome: 'YES' | 'NO';   // Which outcome token
  price: number;           // Trade price (0-1)
  size: number;            // Trade size (shares)
  sizeUsdc: number;        // Trade size in USDC
  timestamp: number;       // Trade timestamp
}

// Whale trade event
export interface WhaleTrade {
  whale: WhaleInfo;
  marketId: string;
  assetId: string;
  side: 'BUY' | 'SELL';
  outcome: 'YES' | 'NO';
  price: number;
  size: number;            // Shares
  sizeUsdc: number;        // USDC value
  timestamp: number;
  isMaker: boolean;
  marketTitle?: string;    // Market question/title
  marketSlug?: string;     // Market slug for URL
}

// Position tracking
export interface Position {
  wallet: string;
  marketId: string;
  outcome: 'YES' | 'NO';
  netShares: number;       // Positive = long, negative = short
  vwapEntry: number;       // Volume-weighted avg entry price
  realizedPnl: number;     // Realized P&L from closed portions
  peakShares: number;      // Peak position size (for exit detection)
  updatedAt: number;
}

// Wallet statistics for ranking
export interface WalletStats {
  address: string;
  volume7d: number;
  volume30d: number;
  pnl7d: number;
  pnl30d: number;
  tradeCount7d: number;
  tradeCount30d: number;
  avgHoldTimeHours: number;
  avgMarketVolume: number;   // Avg volume of markets they trade
  pnlVolatility: number;     // Std dev of trade PnL
  makerRatio: number;        // % of trades as maker
  winRate: number;           // % of profitable trades
  earlyEntryScore: number;
}

// Copy suitability assessment
export interface CopySuitability {
  wallet: string;
  score: number;               // 0-100
  avgHoldTimeHours: number;
  liquidityPreference: 'high' | 'medium' | 'low';
  consistency: number;         // PnL volatility (lower = more consistent)
  makerRatio: number;
  slippageRisk: 'low' | 'medium' | 'high';
  reasoning: string[];         // Why this score
}

// Whale edge signal types
export type WhaleSignalType = 'accumulation' | 'exit' | 'consensus' | 'fade';

// Whale action recommendation
export type WhaleAction = 'COPY' | 'FADE' | 'WATCH' | 'ALERT';

// Whale edge signal
export interface WhaleEdgeSignal {
  marketId: string;
  direction: 'YES' | 'NO';
  magnitude: number;           // Expected remaining move (0.10 = 10%)
  confidence: 'high' | 'medium' | 'low';
  signalType: WhaleSignalType;
  whales: WhaleSignalParticipant[];
  totalWhaleSize: number;      // Total USDC moved
  avgEntryPrice: number;       // Weighted average entry
  timeSinceFirst: number;      // Hours since first whale trade
  action: WhaleAction;
  reasoning: string;
}

// Whale participation in a signal
export interface WhaleSignalParticipant {
  address: string;
  name?: string;
  tier: WhaleTier;
  totalSize: number;           // USDC
  avgEntry: number;
  tradeCount: number;
  copySuitability: number;
}

// Cached whale trade with price snapshot
export interface CachedWhaleTrade {
  trade: WhaleTrade;
  priceAtTrade: number;        // Market price when trade occurred
  timestamp: number;
}

// Leaderboard entry (for bootstrap/enrichment)
export interface LeaderboardEntry {
  rank: number;
  address: string;
  displayName?: string;
  pnl: number;
  volume: number;
  positions: number;
}

// Trade store query options
export interface TradeQueryOptions {
  wallet?: string;
  marketId?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
}

// Market quality assessment
export interface MarketQuality {
  marketId: string;
  volume24h: number;
  spread: number;
  tradeCount24h: number;
  qualityTier: 'high' | 'medium' | 'low' | 'garbage';
}

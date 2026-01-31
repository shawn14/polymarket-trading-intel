/**
 * API Types
 *
 * Type definitions for the REST API responses.
 */

// System status response
export interface SystemStatus {
  uptime: number;
  startedAt: string;
  version: string;

  // Connection status
  connections: {
    polymarket: ConnectionStatus;
    congress: ConnectionStatus;
    weather: ConnectionStatus;
    fed: ConnectionStatus;
    sports: ConnectionStatus;
  };

  // Metrics
  metrics: {
    marketsTracked: number;
    marketsSubscribed: number;
    alertsPerMinute: number;
    signalsDetected: number;
    booksReceived: number;
    pricesReceived: number;
    tradesReceived: number;
  };

  // Data freshness
  lastUpdates: {
    polymarket: number;
    congress: number;
    weather: number;
    fed: number;
    sports: number;
  };
}

export interface ConnectionStatus {
  connected: boolean;
  lastError?: string;
  lastErrorTime?: number;
}

// Market list response
export interface MarketSummary {
  id: string;
  conditionId: string;
  question: string;
  slug: string;
  category: string;
  currentPrice: number;
  tokenIds: string[];
  lastUpdated: number;
}

// Alert response
export interface AlertSummary {
  id: string;
  timestamp: number;
  priority: string;
  source: string;
  title: string;
  body: string;
}

// Playbook analysis response
export interface PlaybookAnalysis {
  marketId: string;
  question: string;
  category: string;
  phase: string;
  urgency: string;
  countdown?: {
    eventName: string;
    daysRemaining: number;
    hoursRemaining: number;
  };
  signals: Array<{
    type: string;
    description: string;
    strength: string;
  }>;
  recommendation?: {
    action: string;
    confidence: number;
    reasoning: string;
    caveats: string[];
  };
  nextEvent?: {
    name: string;
    timestamp: number;
    description: string;
  };
}

// Key dates response
export interface KeyDatesResponse {
  dates: Array<{
    category: string;
    name: string;
    timestamp: number;
    description: string;
    impact: string;
    daysUntil: number;
  }>;
}

// Health check response
export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: {
    polymarket: boolean;
    congress: boolean;
    weather: boolean;
    fed: boolean;
    sports: boolean;
  };
  timestamp: number;
}

// API error response
export interface ErrorResponse {
  error: string;
  code: string;
  timestamp: number;
}

// Browse market response (combined data from multiple sources)
export interface BrowseMarket {
  // Basic info
  id: string;
  question: string;
  slug: string;

  // Pricing
  currentPrice: number;
  spread: number;

  // Categorization
  category: string;
  truthSources: string[];
  keywords: string[];

  // Analysis (if playbook available)
  phase?: string;
  urgency?: string;
  countdown?: { eventName: string; daysRemaining: number };

  // Watchlist status
  isWatched: boolean;
}

// Market Detail Panel Types

// Price history point for charting
export interface PricePoint {
  price: number;
  timestamp: number;
}

// Trade entry for order flow display
export interface TradeEntry {
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  timestamp: number;
}

// Full market detail for the detail panel
export interface MarketDetail {
  // Basic info
  id: string;
  conditionId: string;
  question: string;
  description: string;
  slug: string;

  // Current pricing
  currentPrice: number;
  yesPrice: number;
  noPrice: number;
  impliedProbability: number;

  // Order book
  spread: number;
  bestBid: number;
  bestAsk: number;
  bidDepth: number;
  askDepth: number;

  // Historical data (capped for performance)
  priceHistory: PricePoint[];
  recentTrades: TradeEntry[];

  // Categorization from TruthMarketLinker
  category: string;
  truthSources: string[];
  keywords: string[];

  // Playbook analysis (if available)
  analysis?: PlaybookAnalysis;

  // Metadata
  lastUpdated: number;
  isWatched: boolean;
}

// Events/alerts related to a market
export interface MarketEventsResponse {
  marketId: string;
  events: AlertSummary[];
  totalCount: number;
}

// Related markets (same category or shared keywords)
export interface RelatedMarketsResponse {
  marketId: string;
  sameCategory: RelatedMarket[];
  sharedKeywords: RelatedMarket[];
}

export interface RelatedMarket {
  id: string;
  question: string;
  currentPrice: number;
  category: string;
  sharedKeywords?: string[];
  urgency?: string;
}

// ============================================================================
// Actionability Types - Trading Decision Support
// ============================================================================

// AI lean direction for trade framing
export type AILean = 'YES' | 'NO' | 'NEUTRAL';

// Trade framing box - answers "what should I do at this price?"
export interface TradeFrame {
  // AI recommendation
  lean: AILean;
  confidence: number; // 0-100
  reasoning: string;

  // What's already reflected in price
  pricedIn: string[];

  // What could move the market that isn't priced in
  notPricedIn: string[];

  // Key events that could swing the market
  swingEvents: SwingEvent[];

  // Specific trade ideas
  tradeIdeas: string[];
}

export interface SwingEvent {
  description: string;
  direction: 'up' | 'down'; // ▲ or ▼
  timing?: string; // "any day", "Mar 15", etc.
}

// Price zone classification
export type ZoneType = 'attractive' | 'fair' | 'crowded';

export interface PriceZones {
  // Zone boundaries (as probabilities 0-100)
  attractiveRange: { min: number; max: number };
  fairRange: { min: number; max: number };
  crowdedRange: { min: number; max: number };

  // Current position
  currentPrice: number;
  currentZone: ZoneType;

  // Historical context
  historicalLow: number;
  historicalHigh: number;
  historicalMean: number;
}

// Edge score breakdown
export interface EdgeScore {
  total: number; // 0-100

  // Component scores (each 0-25)
  components: {
    information: number; // Playbook + alerts
    pricing: number; // Zone attractiveness
    timing: number; // Event proximity
    liquidity: number; // Spread + depth
  };

  // Human-readable assessment
  assessment: 'Poor' | 'Fair' | 'Good' | 'Excellent';
}

// Disagreement signals - volume/price divergence warnings
export type DisagreementType =
  | 'high_volume_flat_price' // Absorption
  | 'flow_direction_mismatch' // Divergence
  | 'depth_imbalance'; // One-sided book

export interface DisagreementSignal {
  type: DisagreementType;
  severity: 'low' | 'medium' | 'high';
  description: string;
  implication: string; // What this might mean for trading
}

// Evidence impact labeling
export type EvidenceImpact = 'positive' | 'negative' | 'context';

export type EvidenceMagnitude = 'major' | 'minor';

export interface LabeledEvidence {
  // Original alert data
  id: string;
  timestamp: number;
  title: string;
  body: string;
  source: string;

  // Impact classification
  impact: EvidenceImpact; // ▲ positive, ▼ negative, ◇ context
  magnitude: EvidenceMagnitude;

  // Why we classified it this way
  impactReasoning?: string;
}

export interface EvidenceSummary {
  positive: number; // Count of ▲
  negative: number; // Count of ▼
  context: number; // Count of ◇
  netDirection: 'bullish' | 'bearish' | 'neutral';
}

// Next best action recommendation
export type ActionType =
  | 'set_alert' // Set price alert
  | 'wait' // Wait for better entry
  | 'avoid' // Stay away
  | 'monitor'; // Keep watching

export interface NextBestAction {
  action: ActionType;
  label: string; // Button text
  targetPrice?: number; // For set_alert
  reasoning: string;
}

// User intent storage (for localStorage)
export interface UserIntent {
  action: ActionType;
  timestamp: number;
  notes?: string;
  targetPrice?: number;
}

// Complete actionable market detail response
export interface ActionableMarketDetail extends MarketDetail {
  tradeFrame: TradeFrame;
  priceZones: PriceZones;
  edgeScore: EdgeScore;
  disagreementSignals: DisagreementSignal[];
  labeledEvidence: {
    events: LabeledEvidence[];
    summary: EvidenceSummary;
  };
  nextBestAction: NextBestAction;
}

// ============================================================================
// Edge Scanner Types - Proactive Mispricing Detection
// ============================================================================

// Edge signal for a single market
export interface EdgeSignal {
  direction: 'YES' | 'NO';
  magnitude: number; // Expected remaining move (0.10 = 10%)
  confidence: 'high' | 'medium' | 'low';
  source: 'congress' | 'weather' | 'fed' | 'sports';
  event: string; // "CR passed House 2h ago"
  eventTimestamp: number;
  priceAtEvent?: number; // Price when event occurred
  priceTarget: number; // Where we expect price to go
  timeWindow?: number; // Hours until edge decays
}

// Full opportunity with market context
export interface EdgeOpportunity {
  marketId: string;
  question: string;
  currentPrice: number;
  expectedPrice: number;
  edge: EdgeSignal;
  action: 'BUY_YES' | 'BUY_NO' | 'MONITOR';
  urgency: 'immediate' | 'hours' | 'day';
}

// Active monitoring windows
export interface ActiveWindows {
  fomc: boolean;
  injuryReport: string[]; // leagues currently in window
  hurricaneSeason: boolean;
}

// API response for edge scan
export interface EdgeScanResponse {
  timestamp: number;
  lastScanDuration: number;
  opportunities: EdgeOpportunity[];
  whaleOpportunities?: WhaleEdgeOpportunity[];
  activeWindows: ActiveWindows;
}

// ============================================================================
// Whale Intelligence Types - Smart Money Tracking
// ============================================================================

// Whale tier classification
export type WhaleTier = 'top10' | 'top50' | 'tracked';

// Whale signal types
export type WhaleSignalType = 'accumulation' | 'exit' | 'consensus' | 'fade';

// Whale action recommendation
export type WhaleAction = 'COPY' | 'FADE' | 'WATCH' | 'ALERT';

// Whale participant in a signal
export interface WhaleSignalParticipant {
  address: string;
  name?: string;
  tier: WhaleTier;
  totalSize: number;
  avgEntry: number;
  tradeCount: number;
  copySuitability: number;
}

// Whale edge opportunity
export interface WhaleEdgeOpportunity {
  marketId: string;
  question: string;
  currentPrice: number;
  expectedPrice: number;
  source: 'whale';
  signalType: WhaleSignalType;
  direction: 'YES' | 'NO';
  magnitude: number;
  confidence: 'high' | 'medium' | 'low';
  whales: WhaleSignalParticipant[];
  totalWhaleSize: number;
  avgEntryPrice: number;
  timeSinceFirst: number;
  action: WhaleAction;
  reasoning: string;
  urgency: 'immediate' | 'hours' | 'day';
}

// Whale info for API responses
export interface WhaleInfoResponse {
  address: string;
  name?: string;
  tier: WhaleTier;
  pnl7d: number;
  pnl30d: number;
  volume7d: number;
  volume30d: number;
  tradeCount7d: number;
  tradeCount30d: number;
  earlyEntryScore: number;
  copySuitability: number;
  lastSeen: number;
}

// Whale trade for API responses
export interface WhaleTradeResponse {
  whaleAddress: string;
  whaleName?: string;
  whaleTier: WhaleTier;
  marketId: string;
  marketTitle?: string;
  marketSlug?: string;
  side: 'BUY' | 'SELL';
  outcome: 'YES' | 'NO';
  price: number;
  sizeUsdc: number;
  timestamp: number;
  isMaker: boolean;
}

// API response for whale activity
export interface WhaleActivityResponse {
  timestamp: number;
  topWhales: WhaleInfoResponse[];
  recentTrades: WhaleTradeResponse[];
  activeAccumulations: WhaleEdgeOpportunity[];
  stats: {
    totalWhales: number;
    top10Count: number;
    top50Count: number;
    cachedTrades: number;
  };
}

// Whale positions response
export interface WhalePositionResponse {
  wallet: string;
  marketId: string;
  outcome: 'YES' | 'NO';
  netShares: number;
  vwapEntry: number;
  realizedPnl: number;
  peakShares: number;
  reductionFromPeak: number;
}

// ============================================================================
// Kalshi Market Types - Cross-Platform Intelligence
// ============================================================================

// Kalshi market view for dashboard display
export interface KalshiMarketResponse {
  ticker: string;
  eventTicker: string;
  title: string;
  subtitle?: string;
  yesPrice: number;
  noPrice: number;
  lastPrice: number;
  priceChange24h: number;
  volume24h: number;
  totalVolume: number;
  liquidity: number;
  openInterest: number;
  closeTime?: string;
  category?: string;
  url: string;
}

// Kalshi markets list response
export interface KalshiMarketsListResponse {
  timestamp: number;
  markets: KalshiMarketResponse[];
  sortType: 'movers' | 'trending' | 'newest' | 'volume';
  count: number;
}

// Kalshi stats response
export interface KalshiStatsResponse {
  cachedMarkets: number;
  lastFetch: number;
  cacheAgeMs: number;
  isStale: boolean;
}

// ============================================================================
// Whale Profile Types - Detailed Whale Analysis
// ============================================================================

// Position with market context for profile display
export interface WhaleProfilePosition {
  marketId: string;
  marketTitle?: string;
  outcome: 'YES' | 'NO';
  netShares: number;
  vwapEntry: number;
  currentPrice?: number;
  unrealizedPnl?: number;
  realizedPnl: number;
  peakShares: number;
  reductionFromPeak: number;
}

// Strategy analysis for a whale
export interface WhaleStrategyAnalysis {
  // Trade patterns
  avgTradeSize: number;      // Average USDC per trade
  preferredOutcome: 'YES' | 'NO' | 'balanced';  // Do they favor YES or NO?
  makerVsTaker: 'maker' | 'taker' | 'mixed';  // Mostly providing or taking liquidity?
  avgHoldingPeriod: string;  // "short" (< 1d), "medium" (1-7d), "long" (> 7d)

  // Market preferences
  topMarkets: Array<{
    marketId: string;
    marketTitle?: string;
    tradeCount: number;
    totalVolume: number;
  }>;

  // Performance metrics
  winRate?: number;          // Estimated win rate if we have resolved positions
  avgProfitPerTrade?: number;

  // Behavioral traits
  traits: string[];          // e.g., ["early_mover", "high_conviction", "contrarian"]
}

// Complete whale profile response
export interface WhaleProfileResponse {
  // Basic info (from WhaleInfo)
  address: string;
  name?: string;
  tier: WhaleTier;
  rank?: number;             // Leaderboard rank if known

  // PnL metrics
  pnl7d: number;
  pnl30d: number;
  pnlAllTime?: number;       // From leaderboard if available
  estimatedAccountValue?: number;  // Sum of position values + realized PnL

  // Volume metrics
  volume7d: number;
  volume30d: number;
  tradeCount7d: number;
  tradeCount30d: number;

  // Scoring
  earlyEntryScore: number;
  copySuitability: number;
  lastSeen: number;

  // Recent trades
  recentTrades: WhaleTradeResponse[];

  // Current positions
  positions: WhaleProfilePosition[];

  // Strategy analysis
  strategy: WhaleStrategyAnalysis;

  // Meta
  profileGeneratedAt: number;

  // Expert specialties (if tracked)
  specialties?: ExpertSpecialtyResponse[];
}

// ============================================================================
// Expert Tracking Types - Category-Based Expertise
// ============================================================================

// Market category types
export type MarketCategory = 'sports' | 'crypto' | 'politics' | 'weather' | 'entertainment' | 'finance' | 'science' | 'other';

// Expert specialty for API response
export interface ExpertSpecialtyResponse {
  category: MarketCategory;
  winRate: number;
  tradeCount: number;
  totalVolume: number;
  confidence: 'high' | 'medium' | 'low';
  profitability: number;
}

// Expert profile for API response
export interface ExpertProfileResponse {
  address: string;
  name?: string;
  tier: WhaleTier;
  pnl30d: number;
  specialties: ExpertSpecialtyResponse[];
  overallWinRate?: number;
  totalTrackedTrades: number;
  primaryCategory?: MarketCategory;
}

// API response for experts list
export interface ExpertsListResponse {
  timestamp: number;
  experts: ExpertProfileResponse[];
  byCategory: Record<MarketCategory, number>;
  totalTrackedTrades: number;
}

// ============================================================================
// Strategy Analyzer Types - Whale Trading Strategy Classification
// ============================================================================

// Strategy type classification
export type StrategyType =
  | 'crypto_premium_seller'
  | 'crypto_directional'
  | 'crypto_scalper'
  | 'sports_bettor'
  | 'political_trader'
  | 'weather_specialist'
  | 'diversified'
  | 'unknown';

// Market type for position classification
export type MarketTypeDetailed =
  | 'crypto_dip'
  | 'crypto_reach'
  | 'crypto_daily'
  | 'crypto_15m'
  | 'crypto_other'
  | 'sports'
  | 'politics'
  | 'economics'
  | 'weather'
  | 'entertainment'
  | 'other';

// Market focus breakdown
export interface MarketFocusResponse {
  type: MarketTypeDetailed;
  count: number;
  pnl: number;
  volume: number;
  winRate: number;
}

// Trader position from data API
export interface TraderPositionResponse {
  conditionId: string;
  title: string;
  slug: string;
  outcome: 'Yes' | 'No';
  size: number;
  avgPrice: number;
  curPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
}

// Full strategy profile response
export interface StrategyProfileResponse {
  address: string;
  username?: string;
  pnl: number;
  volume: number;

  // Strategy classification
  strategyType: StrategyType;
  strategyLabel: string;
  strategyConfidence: 'high' | 'medium' | 'low';

  // Market breakdown
  marketFocus: MarketFocusResponse[];
  primaryMarket: MarketTypeDetailed;

  // Trading metrics
  winRate: number;
  avgPositionSize: number;
  directionalBias: 'bullish' | 'bearish' | 'neutral';
  concentration: number;

  // Position stats
  totalPositions: number;
  openPositions: number;
  yesPositions: number;
  noPositions: number;

  // Crypto-specific subtypes
  cryptoSubtypes?: {
    dip: number;
    reach: number;
    daily: number;
    fifteenMin: number;
    other: number;
  };

  // Top positions
  topPositions?: TraderPositionResponse[];

  analyzedAt: number;
}

// Strategy comparison for leaderboard
export interface StrategyComparisonResponse {
  timestamp: number;
  strategies: Array<{
    type: StrategyType;
    label: string;
    traderCount: number;
    totalPnl: number;
    avgWinRate: number;
    topTraders: Array<{
      address: string;
      username?: string;
      pnl: number;
      winRate: number;
    }>;
  }>;
  totalTradersAnalyzed: number;
}

// Category leaderboard response
export interface CategoryLeaderboardResponse {
  timestamp: number;
  category: string;
  traders: Array<{
    rank: number;
    address: string;
    username?: string;
    pnl: number;
    strategyType?: StrategyType;
    strategyLabel?: string;
  }>;
}

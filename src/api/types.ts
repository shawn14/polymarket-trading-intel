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

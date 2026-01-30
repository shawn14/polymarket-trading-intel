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

/**
 * Analysis Module Types
 *
 * Types for the "Explain This Move" engine and cross-market analysis.
 */

// Move explanation result
export interface MoveExplanation {
  marketId: string;
  question: string;

  // The move itself
  move: {
    direction: 'up' | 'down';
    magnitude: number;        // Percentage change (e.g., 0.05 = 5%)
    fromPrice: number;
    toPrice: number;
    timestamp: number;
    durationMs: number;       // How long the move took
  };

  // Classification
  moveType: 'truth_driven' | 'flow_driven' | 'mixed' | 'unknown';
  confidence: 'very_high' | 'high' | 'medium' | 'low';

  // What caused it
  triggers: MoveTrigger[];

  // Market context
  context: {
    volumeSpike: boolean;
    spreadCompression: boolean;
    largeTrades: number;
    bookImbalance?: 'bid_heavy' | 'ask_heavy' | 'balanced';
  };

  // Related markets
  relatedMoves: RelatedMove[];

  // Historical comparison
  historicalAnalogs?: HistoricalAnalog[];

  // Human-readable summary
  summary: string;
  details: string[];
}

// What triggered the move
export interface MoveTrigger {
  source: 'congress' | 'weather' | 'fed' | 'sports' | 'market_flow' | 'unknown';
  type: string;
  description: string;
  timestamp: number;
  confidence: number;  // 0-1
  data?: Record<string, unknown>;
}

// Related market movement
export interface RelatedMove {
  marketId: string;
  question: string;
  relationship: 'correlated' | 'inverse' | 'causal';
  move: {
    direction: 'up' | 'down';
    magnitude: number;
  };
  lag: number;  // ms after primary move
}

// Historical pattern match
export interface HistoricalAnalog {
  date: string;
  description: string;
  similarity: number;  // 0-1
  outcome: string;
}

// Cross-market arbitrage opportunity
export interface ArbOpportunity {
  id: string;
  timestamp: number;
  type: 'logical' | 'correlation' | 'calendar';

  // The markets involved
  markets: ArbMarket[];

  // The opportunity
  description: string;
  expectedEdge: number;      // Expected profit as decimal (0.02 = 2%)
  confidence: 'high' | 'medium' | 'low';

  // Risk factors
  risks: string[];

  // Time sensitivity
  urgency: 'immediate' | 'hours' | 'days';
  expiresAt?: number;
}

// Market in an arb opportunity
export interface ArbMarket {
  marketId: string;
  question: string;
  currentPrice: number;
  impliedPrice: number;      // What it "should" be
  position: 'buy_yes' | 'buy_no' | 'sell_yes' | 'sell_no';
  size?: number;             // Suggested position size
}

// Market relationship for arb detection
export interface MarketRelationship {
  market1Id: string;
  market2Id: string;
  relationshipType: 'mutually_exclusive' | 'subset' | 'correlated' | 'inverse';
  constraint?: {
    // For mutually exclusive: P(A) + P(B) <= 1
    // For subset: P(A) <= P(B)
    // For correlated: P(A) ≈ P(B) * factor
    type: 'sum_max' | 'ratio' | 'difference';
    value: number;
    tolerance: number;
  };
}

// Price history for a market
export interface PricePoint {
  timestamp: number;
  price: number;
  volume?: number;
}

export interface MarketPriceHistory {
  marketId: string;
  prices: PricePoint[];
  lastUpdated: number;
}

// Significant move detected
export interface SignificantMove {
  marketId: string;
  question: string;
  startTime: number;
  endTime: number;
  startPrice: number;
  endPrice: number;
  magnitude: number;
  direction: 'up' | 'down';
}

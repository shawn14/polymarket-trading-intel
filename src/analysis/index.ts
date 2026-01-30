/**
 * Analysis Module
 *
 * Advanced market analysis including:
 * - "Explain This Move" engine
 * - Cross-market arbitrage detection
 */

export { ExplainMoveEngine, type ExplainMoveConfig, type ExplainMoveEvents } from './explain-move.js';
export { ArbDetector, type ArbDetectorConfig, type ArbDetectorEvents } from './arb-detector.js';

export type {
  MoveExplanation,
  MoveTrigger,
  RelatedMove,
  HistoricalAnalog,
  ArbOpportunity,
  ArbMarket,
  MarketRelationship,
  PricePoint,
  MarketPriceHistory,
  SignificantMove,
} from './types.js';

/**
 * Explain This Move Engine
 *
 * When a market moves significantly, explains why:
 * - What truth sources changed
 * - Whether move is news-driven or flow-driven
 * - Related market movements
 * - Historical analogs
 */

import { EventEmitter } from 'events';
import type { PolymarketClient } from '../ingestion/polymarket/client.js';
import type { Signal } from '../signals/types.js';
import type {
  MoveExplanation,
  MoveTrigger,
  RelatedMove,
  SignificantMove,
  PricePoint,
  MarketPriceHistory,
} from './types.js';

// Configuration
const DEFAULT_MOVE_THRESHOLD = 0.03;  // 3% move triggers explanation
const DEFAULT_LOOKBACK_MS = 5 * 60 * 1000;  // 5 minute lookback
const DEFAULT_HISTORY_LENGTH = 100;  // Keep 100 price points per market

export interface ExplainMoveConfig {
  moveThreshold?: number;
  lookbackMs?: number;
  historyLength?: number;
}

export interface ExplainMoveEvents {
  explanation: [explanation: MoveExplanation];
  significantMove: [move: SignificantMove];
}

export class ExplainMoveEngine extends EventEmitter<ExplainMoveEvents> {
  private config: Required<ExplainMoveConfig>;
  private priceHistory: Map<string, MarketPriceHistory> = new Map();
  private recentSignals: Signal[] = [];
  private recentTruthEvents: MoveTrigger[] = [];
  private marketQuestions: Map<string, string> = new Map();

  constructor(config: ExplainMoveConfig = {}) {
    super();
    this.config = {
      moveThreshold: config.moveThreshold ?? DEFAULT_MOVE_THRESHOLD,
      lookbackMs: config.lookbackMs ?? DEFAULT_LOOKBACK_MS,
      historyLength: config.historyLength ?? DEFAULT_HISTORY_LENGTH,
    };
  }

  /**
   * Attach to Polymarket client to track price changes
   */
  attachPolymarket(client: PolymarketClient): void {
    client.on('price', (update) => {
      this.recordPrice(update.assetId, update.price);
      this.checkForSignificantMove(update.assetId);
    });

    console.log('[ExplainMove] Attached to Polymarket client');
  }

  /**
   * Record a signal for correlation with moves
   */
  recordSignal(signal: Signal): void {
    this.recentSignals.push(signal);
    // Keep last 100 signals
    if (this.recentSignals.length > 100) {
      this.recentSignals = this.recentSignals.slice(-100);
    }
  }

  /**
   * Record a truth event (from any connector)
   */
  recordTruthEvent(trigger: MoveTrigger): void {
    this.recentTruthEvents.push(trigger);
    // Keep last 50 events
    if (this.recentTruthEvents.length > 50) {
      this.recentTruthEvents = this.recentTruthEvents.slice(-50);
    }
  }

  /**
   * Set market question for better explanations
   */
  setMarketQuestion(assetId: string, question: string): void {
    this.marketQuestions.set(assetId, question);
  }

  /**
   * Manually explain a move for a specific market
   */
  async explainMove(
    marketId: string,
    fromPrice: number,
    toPrice: number,
    timestamp: number = Date.now()
  ): Promise<MoveExplanation> {
    const magnitude = Math.abs(toPrice - fromPrice);
    const direction = toPrice > fromPrice ? 'up' : 'down';
    const question = this.marketQuestions.get(marketId) || 'Unknown market';

    // Find triggers in the lookback window
    const triggers = this.findTriggers(marketId, timestamp);

    // Classify the move
    const { moveType, confidence } = this.classifyMove(triggers, magnitude);

    // Get market context from recent signals
    const context = this.getMarketContext(marketId, timestamp);

    // Find related moves
    const relatedMoves = this.findRelatedMoves(marketId, timestamp, direction);

    // Generate summary
    const { summary, details } = this.generateSummary(
      direction,
      magnitude,
      moveType,
      triggers,
      context
    );

    const explanation: MoveExplanation = {
      marketId,
      question,
      move: {
        direction,
        magnitude,
        fromPrice,
        toPrice,
        timestamp,
        durationMs: this.config.lookbackMs,
      },
      moveType,
      confidence,
      triggers,
      context,
      relatedMoves,
      summary,
      details,
    };

    this.emit('explanation', explanation);
    return explanation;
  }

  /**
   * Record a price update
   */
  private recordPrice(assetId: string, price: number): void {
    let history = this.priceHistory.get(assetId);

    if (!history) {
      history = {
        marketId: assetId,
        prices: [],
        lastUpdated: Date.now(),
      };
      this.priceHistory.set(assetId, history);
    }

    history.prices.push({
      timestamp: Date.now(),
      price,
    });

    // Trim history
    if (history.prices.length > this.config.historyLength) {
      history.prices = history.prices.slice(-this.config.historyLength);
    }

    history.lastUpdated = Date.now();
  }

  /**
   * Check if a market has had a significant move
   */
  private checkForSignificantMove(assetId: string): void {
    const history = this.priceHistory.get(assetId);
    if (!history || history.prices.length < 2) return;

    const now = Date.now();
    const lookbackStart = now - this.config.lookbackMs;

    // Get prices in lookback window
    const recentPrices = history.prices.filter((p) => p.timestamp >= lookbackStart);
    if (recentPrices.length < 2) return;

    const startPrice = recentPrices[0].price;
    const endPrice = recentPrices[recentPrices.length - 1].price;
    const magnitude = Math.abs(endPrice - startPrice);

    if (magnitude >= this.config.moveThreshold) {
      const move: SignificantMove = {
        marketId: assetId,
        question: this.marketQuestions.get(assetId) || 'Unknown',
        startTime: recentPrices[0].timestamp,
        endTime: recentPrices[recentPrices.length - 1].timestamp,
        startPrice,
        endPrice,
        magnitude,
        direction: endPrice > startPrice ? 'up' : 'down',
      };

      this.emit('significantMove', move);

      // Auto-explain the move
      this.explainMove(assetId, startPrice, endPrice, now);
    }
  }

  /**
   * Find triggers that could explain a move
   */
  private findTriggers(marketId: string, timestamp: number): MoveTrigger[] {
    const lookbackStart = timestamp - this.config.lookbackMs;
    const triggers: MoveTrigger[] = [];

    // Check recent truth events
    for (const event of this.recentTruthEvents) {
      if (event.timestamp >= lookbackStart && event.timestamp <= timestamp) {
        triggers.push(event);
      }
    }

    // Check recent signals for this market
    for (const signal of this.recentSignals) {
      if (
        signal.assetId === marketId &&
        signal.timestamp >= lookbackStart &&
        signal.timestamp <= timestamp
      ) {
        triggers.push({
          source: 'market_flow',
          type: signal.type,
          description: signal.description,
          timestamp: signal.timestamp,
          confidence: signal.strength === 'very_high' ? 0.9 :
            signal.strength === 'high' ? 0.7 :
            signal.strength === 'medium' ? 0.5 : 0.3,
          data: signal.data as unknown as Record<string, unknown> | undefined,
        });
      }
    }

    // Sort by timestamp
    triggers.sort((a, b) => a.timestamp - b.timestamp);

    return triggers;
  }

  /**
   * Classify the type of move
   */
  private classifyMove(
    triggers: MoveTrigger[],
    magnitude: number
  ): { moveType: MoveExplanation['moveType']; confidence: MoveExplanation['confidence'] } {
    const truthTriggers = triggers.filter((t) => t.source !== 'market_flow');
    const flowTriggers = triggers.filter((t) => t.source === 'market_flow');

    // Truth-driven: has truth triggers with high confidence
    const hasTruthTrigger = truthTriggers.some((t) => t.confidence >= 0.7);
    const hasFlowTrigger = flowTriggers.length > 0;

    if (hasTruthTrigger && !hasFlowTrigger) {
      return {
        moveType: 'truth_driven',
        confidence: 'very_high',
      };
    }

    if (hasTruthTrigger && hasFlowTrigger) {
      return {
        moveType: 'mixed',
        confidence: 'high',
      };
    }

    if (hasFlowTrigger && !hasTruthTrigger) {
      return {
        moveType: 'flow_driven',
        confidence: flowTriggers.some((t) => t.confidence >= 0.7) ? 'high' : 'medium',
      };
    }

    // No clear triggers
    return {
      moveType: 'unknown',
      confidence: 'low',
    };
  }

  /**
   * Get market context from recent activity
   */
  private getMarketContext(
    marketId: string,
    timestamp: number
  ): MoveExplanation['context'] {
    const lookbackStart = timestamp - this.config.lookbackMs;
    const relevantSignals = this.recentSignals.filter(
      (s) =>
        s.assetId === marketId &&
        s.timestamp >= lookbackStart &&
        s.timestamp <= timestamp
    );

    return {
      volumeSpike: relevantSignals.some((s) => s.type === 'volume_spike'),
      spreadCompression: relevantSignals.some((s) => s.type === 'spread_compression'),
      largeTrades: relevantSignals.filter((s) => s.type === 'aggressive_sweep').length,
      bookImbalance: this.detectBookImbalance(relevantSignals),
    };
  }

  /**
   * Detect book imbalance from signals
   */
  private detectBookImbalance(
    signals: Signal[]
  ): 'bid_heavy' | 'ask_heavy' | 'balanced' | undefined {
    const depthPulls = signals.filter((s) => s.type === 'depth_pull');
    if (depthPulls.length === 0) return undefined;

    // Check the most recent depth pull
    const latest = depthPulls[depthPulls.length - 1];
    const data = latest.data as { side?: string } | undefined;

    if (data?.side === 'bid') return 'ask_heavy';
    if (data?.side === 'ask') return 'bid_heavy';
    return 'balanced';
  }

  /**
   * Find related market moves
   */
  private findRelatedMoves(
    marketId: string,
    timestamp: number,
    direction: 'up' | 'down'
  ): RelatedMove[] {
    const relatedMoves: RelatedMove[] = [];
    const lookbackStart = timestamp - this.config.lookbackMs;

    for (const [assetId, history] of this.priceHistory) {
      if (assetId === marketId) continue;

      const recentPrices = history.prices.filter(
        (p) => p.timestamp >= lookbackStart && p.timestamp <= timestamp
      );

      if (recentPrices.length < 2) continue;

      const startPrice = recentPrices[0].price;
      const endPrice = recentPrices[recentPrices.length - 1].price;
      const magnitude = Math.abs(endPrice - startPrice);

      if (magnitude >= this.config.moveThreshold * 0.5) {
        const moveDirection = endPrice > startPrice ? 'up' : 'down';
        const relationship = moveDirection === direction ? 'correlated' : 'inverse';

        relatedMoves.push({
          marketId: assetId,
          question: this.marketQuestions.get(assetId) || 'Unknown',
          relationship,
          move: {
            direction: moveDirection,
            magnitude,
          },
          lag: recentPrices[recentPrices.length - 1].timestamp - timestamp,
        });
      }
    }

    return relatedMoves.slice(0, 5);  // Top 5 related moves
  }

  /**
   * Generate human-readable summary
   */
  private generateSummary(
    direction: 'up' | 'down',
    magnitude: number,
    moveType: MoveExplanation['moveType'],
    triggers: MoveTrigger[],
    context: MoveExplanation['context']
  ): { summary: string; details: string[] } {
    const pctMove = (magnitude * 100).toFixed(1);
    const dirWord = direction === 'up' ? 'up' : 'down';
    const details: string[] = [];

    let summary: string;

    switch (moveType) {
      case 'truth_driven':
        const truthTrigger = triggers.find((t) => t.source !== 'market_flow');
        summary = `Market moved ${dirWord} ${pctMove}% on ${truthTrigger?.source || 'news'}: ${truthTrigger?.description || 'truth source update'}`;
        break;

      case 'flow_driven':
        summary = `Market moved ${dirWord} ${pctMove}% on heavy flow (no clear news trigger)`;
        break;

      case 'mixed':
        summary = `Market moved ${dirWord} ${pctMove}% - news catalyst with confirming flow`;
        break;

      default:
        summary = `Market moved ${dirWord} ${pctMove}% - cause unclear`;
    }

    // Add context details
    if (context.volumeSpike) {
      details.push('Volume spike detected');
    }
    if (context.spreadCompression) {
      details.push('Spread compressed (informed buyer signal)');
    }
    if (context.largeTrades > 0) {
      details.push(`${context.largeTrades} aggressive sweep(s) detected`);
    }
    if (context.bookImbalance) {
      details.push(`Order book ${context.bookImbalance.replace('_', ' ')}`);
    }

    // Add trigger details
    for (const trigger of triggers) {
      if (trigger.source !== 'market_flow') {
        details.push(`[${trigger.source.toUpperCase()}] ${trigger.description}`);
      }
    }

    return { summary, details };
  }
}

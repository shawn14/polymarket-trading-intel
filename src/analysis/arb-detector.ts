/**
 * Cross-Market Arbitrage Detector
 *
 * Detects mispricing between related markets:
 * - Mutually exclusive outcomes (should sum to <= 1)
 * - Correlated markets (should move together)
 * - Inverse relationships (one up = other down)
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type {
  ArbOpportunity,
  ArbMarket,
  MarketRelationship,
} from './types.js';

// Configuration
const DEFAULT_MIN_EDGE = 0.02;  // 2% minimum edge to alert
const DEFAULT_CHECK_INTERVAL_MS = 30 * 1000;  // Check every 30 seconds

export interface ArbDetectorConfig {
  minEdge?: number;
  checkIntervalMs?: number;
}

export interface ArbDetectorEvents {
  opportunity: [opportunity: ArbOpportunity];
}

interface TrackedMarket {
  id: string;
  question: string;
  currentPrice: number;
  lastUpdated: number;
}

export class ArbDetector extends EventEmitter<ArbDetectorEvents> {
  private config: Required<ArbDetectorConfig>;
  private markets: Map<string, TrackedMarket> = new Map();
  private relationships: MarketRelationship[] = [];
  private checkTimer: NodeJS.Timeout | null = null;
  private seenOpportunities: Set<string> = new Set();  // Dedup

  constructor(config: ArbDetectorConfig = {}) {
    super();
    this.config = {
      minEdge: config.minEdge ?? DEFAULT_MIN_EDGE,
      checkIntervalMs: config.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
    };
  }

  /**
   * Start monitoring for arbitrage opportunities
   */
  start(): void {
    if (this.checkTimer) return;

    console.log('[ArbDetector] Starting arbitrage monitor');
    this.checkTimer = setInterval(() => this.checkAllRelationships(), this.config.checkIntervalMs);
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * Update a market's current price
   */
  updateMarket(id: string, question: string, price: number): void {
    this.markets.set(id, {
      id,
      question,
      currentPrice: price,
      lastUpdated: Date.now(),
    });

    // Auto-detect relationships based on keywords
    this.autoDetectRelationships(id, question);
  }

  /**
   * Manually add a relationship between markets
   */
  addRelationship(relationship: MarketRelationship): void {
    // Avoid duplicates
    const exists = this.relationships.some(
      (r) =>
        (r.market1Id === relationship.market1Id && r.market2Id === relationship.market2Id) ||
        (r.market1Id === relationship.market2Id && r.market2Id === relationship.market1Id)
    );

    if (!exists) {
      this.relationships.push(relationship);
    }
  }

  /**
   * Get all current opportunities
   */
  getCurrentOpportunities(): ArbOpportunity[] {
    const opportunities: ArbOpportunity[] = [];

    for (const relationship of this.relationships) {
      const opp = this.checkRelationship(relationship);
      if (opp) {
        opportunities.push(opp);
      }
    }

    return opportunities;
  }

  /**
   * Check all relationships for arbitrage
   */
  private checkAllRelationships(): void {
    for (const relationship of this.relationships) {
      const opportunity = this.checkRelationship(relationship);
      if (opportunity) {
        // Dedup by market pair + direction
        const key = `${relationship.market1Id}-${relationship.market2Id}-${opportunity.type}`;
        if (!this.seenOpportunities.has(key)) {
          this.seenOpportunities.add(key);
          this.emit('opportunity', opportunity);

          // Clear from seen after 5 minutes
          setTimeout(() => this.seenOpportunities.delete(key), 5 * 60 * 1000);
        }
      }
    }
  }

  /**
   * Check a single relationship for arbitrage opportunity
   */
  private checkRelationship(relationship: MarketRelationship): ArbOpportunity | null {
    const market1 = this.markets.get(relationship.market1Id);
    const market2 = this.markets.get(relationship.market2Id);

    if (!market1 || !market2) return null;

    // Check for stale data (> 5 minutes old)
    const now = Date.now();
    if (now - market1.lastUpdated > 5 * 60 * 1000 || now - market2.lastUpdated > 5 * 60 * 1000) {
      return null;
    }

    switch (relationship.relationshipType) {
      case 'mutually_exclusive':
        return this.checkMutuallyExclusive(market1, market2, relationship);

      case 'inverse':
        return this.checkInverse(market1, market2, relationship);

      case 'correlated':
        return this.checkCorrelated(market1, market2, relationship);

      case 'subset':
        return this.checkSubset(market1, market2, relationship);

      default:
        return null;
    }
  }

  /**
   * Check mutually exclusive markets (P(A) + P(B) should be <= 1)
   */
  private checkMutuallyExclusive(
    market1: TrackedMarket,
    market2: TrackedMarket,
    relationship: MarketRelationship
  ): ArbOpportunity | null {
    const sum = market1.currentPrice + market2.currentPrice;
    const maxSum = relationship.constraint?.value ?? 1.0;
    const tolerance = relationship.constraint?.tolerance ?? 0.02;

    // If sum > max + tolerance, there's an arb
    if (sum > maxSum + tolerance) {
      const edge = sum - maxSum;

      if (edge < this.config.minEdge) return null;

      return {
        id: randomUUID(),
        timestamp: Date.now(),
        type: 'logical',
        markets: [
          {
            marketId: market1.id,
            question: market1.question,
            currentPrice: market1.currentPrice,
            impliedPrice: maxSum - market2.currentPrice,
            position: 'buy_no',
          },
          {
            marketId: market2.id,
            question: market2.question,
            currentPrice: market2.currentPrice,
            impliedPrice: maxSum - market1.currentPrice,
            position: 'buy_no',
          },
        ],
        description: `Mutually exclusive markets sum to ${(sum * 100).toFixed(1)}% (should be ≤${(maxSum * 100).toFixed(0)}%). Buy NO on both for guaranteed profit.`,
        expectedEdge: edge,
        confidence: edge > 0.05 ? 'high' : 'medium',
        risks: [
          'Execution risk - prices may move before both trades fill',
          'Liquidity - may not get full size at these prices',
        ],
        urgency: edge > 0.1 ? 'immediate' : 'hours',
      };
    }

    return null;
  }

  /**
   * Check inverse markets (P(A) + P(B) should be ≈ 1)
   */
  private checkInverse(
    market1: TrackedMarket,
    market2: TrackedMarket,
    relationship: MarketRelationship
  ): ArbOpportunity | null {
    const sum = market1.currentPrice + market2.currentPrice;
    const target = relationship.constraint?.value ?? 1.0;
    const tolerance = relationship.constraint?.tolerance ?? 0.03;

    const deviation = Math.abs(sum - target);

    if (deviation > tolerance) {
      const edge = deviation;

      if (edge < this.config.minEdge) return null;

      // Determine which way to trade
      const buyMarket1Yes = sum < target;  // If sum too low, buy YES on both

      return {
        id: randomUUID(),
        timestamp: Date.now(),
        type: 'logical',
        markets: [
          {
            marketId: market1.id,
            question: market1.question,
            currentPrice: market1.currentPrice,
            impliedPrice: target - market2.currentPrice,
            position: buyMarket1Yes ? 'buy_yes' : 'buy_no',
          },
          {
            marketId: market2.id,
            question: market2.question,
            currentPrice: market2.currentPrice,
            impliedPrice: target - market1.currentPrice,
            position: buyMarket1Yes ? 'buy_yes' : 'buy_no',
          },
        ],
        description: sum < target
          ? `Inverse markets sum to only ${(sum * 100).toFixed(1)}% (should be ~${(target * 100).toFixed(0)}%). Both underpriced.`
          : `Inverse markets sum to ${(sum * 100).toFixed(1)}% (should be ~${(target * 100).toFixed(0)}%). Both overpriced.`,
        expectedEdge: edge,
        confidence: edge > 0.05 ? 'high' : 'medium',
        risks: [
          'Markets may not be perfectly inverse',
          'Settlement timing differences',
        ],
        urgency: 'hours',
      };
    }

    return null;
  }

  /**
   * Check correlated markets (should have similar prices)
   */
  private checkCorrelated(
    market1: TrackedMarket,
    market2: TrackedMarket,
    relationship: MarketRelationship
  ): ArbOpportunity | null {
    const factor = relationship.constraint?.value ?? 1.0;
    const tolerance = relationship.constraint?.tolerance ?? 0.05;

    const expectedPrice2 = market1.currentPrice * factor;
    const deviation = Math.abs(market2.currentPrice - expectedPrice2);

    if (deviation > tolerance) {
      const edge = deviation;

      if (edge < this.config.minEdge) return null;

      const market2Overpriced = market2.currentPrice > expectedPrice2;

      return {
        id: randomUUID(),
        timestamp: Date.now(),
        type: 'correlation',
        markets: [
          {
            marketId: market1.id,
            question: market1.question,
            currentPrice: market1.currentPrice,
            impliedPrice: market1.currentPrice,
            position: market2Overpriced ? 'buy_yes' : 'buy_no',
          },
          {
            marketId: market2.id,
            question: market2.question,
            currentPrice: market2.currentPrice,
            impliedPrice: expectedPrice2,
            position: market2Overpriced ? 'buy_no' : 'buy_yes',
          },
        ],
        description: market2Overpriced
          ? `Correlated market divergence: Market 2 at ${(market2.currentPrice * 100).toFixed(1)}% vs expected ${(expectedPrice2 * 100).toFixed(1)}%`
          : `Correlated market divergence: Market 2 at ${(market2.currentPrice * 100).toFixed(1)}% vs expected ${(expectedPrice2 * 100).toFixed(1)}%`,
        expectedEdge: edge,
        confidence: 'medium',
        risks: [
          'Correlation may be temporary',
          'Markets may have different settlement criteria',
        ],
        urgency: 'days',
      };
    }

    return null;
  }

  /**
   * Check subset markets (P(A) <= P(B) if A is subset of B)
   */
  private checkSubset(
    market1: TrackedMarket,  // Subset (more specific)
    market2: TrackedMarket,  // Superset (more general)
    relationship: MarketRelationship
  ): ArbOpportunity | null {
    const tolerance = relationship.constraint?.tolerance ?? 0.02;

    // Subset price should be <= superset price
    if (market1.currentPrice > market2.currentPrice + tolerance) {
      const edge = market1.currentPrice - market2.currentPrice;

      if (edge < this.config.minEdge) return null;

      return {
        id: randomUUID(),
        timestamp: Date.now(),
        type: 'logical',
        markets: [
          {
            marketId: market1.id,
            question: market1.question,
            currentPrice: market1.currentPrice,
            impliedPrice: market2.currentPrice,
            position: 'buy_no',
          },
          {
            marketId: market2.id,
            question: market2.question,
            currentPrice: market2.currentPrice,
            impliedPrice: market1.currentPrice,
            position: 'buy_yes',
          },
        ],
        description: `Subset mispricing: Specific outcome priced higher (${(market1.currentPrice * 100).toFixed(1)}%) than general outcome (${(market2.currentPrice * 100).toFixed(1)}%)`,
        expectedEdge: edge,
        confidence: 'high',
        risks: [
          'Check settlement criteria carefully',
        ],
        urgency: 'hours',
      };
    }

    return null;
  }

  /**
   * Auto-detect relationships based on market question keywords
   */
  private autoDetectRelationships(newMarketId: string, question: string): void {
    const qLower = question.toLowerCase();

    for (const [existingId, existing] of this.markets) {
      if (existingId === newMarketId) continue;

      const existingLower = existing.question.toLowerCase();

      // Check for Yes/No variants of same question
      if (this.areSameQuestionYesNo(qLower, existingLower)) {
        this.addRelationship({
          market1Id: newMarketId,
          market2Id: existingId,
          relationshipType: 'inverse',
          constraint: { type: 'sum_max', value: 1.0, tolerance: 0.02 },
        });
        continue;
      }

      // Check for mutually exclusive outcomes (e.g., "Team A wins" vs "Team B wins")
      if (this.areMutuallyExclusive(qLower, existingLower)) {
        this.addRelationship({
          market1Id: newMarketId,
          market2Id: existingId,
          relationshipType: 'mutually_exclusive',
          constraint: { type: 'sum_max', value: 1.0, tolerance: 0.02 },
        });
        continue;
      }

      // Check for subset relationships
      if (this.isSubset(qLower, existingLower)) {
        this.addRelationship({
          market1Id: newMarketId,
          market2Id: existingId,
          relationshipType: 'subset',
          constraint: { type: 'difference', value: 0, tolerance: 0.02 },
        });
      }
    }
  }

  /**
   * Check if two questions are Yes/No variants
   */
  private areSameQuestionYesNo(q1: string, q2: string): boolean {
    // Simple heuristic: if one has "not" and the other doesn't
    const hasNot1 = q1.includes(' not ') || q1.includes("won't") || q1.includes("will not");
    const hasNot2 = q2.includes(' not ') || q2.includes("won't") || q2.includes("will not");

    if (hasNot1 !== hasNot2) {
      // Remove negation words and compare
      const clean1 = q1.replace(/ not /g, ' ').replace(/won't/g, 'will').replace(/will not/g, 'will');
      const clean2 = q2.replace(/ not /g, ' ').replace(/won't/g, 'will').replace(/will not/g, 'will');

      // Check similarity (simple overlap)
      const words1 = new Set(clean1.split(/\s+/));
      const words2 = new Set(clean2.split(/\s+/));
      const overlap = [...words1].filter((w) => words2.has(w)).length;
      const minSize = Math.min(words1.size, words2.size);

      return overlap / minSize > 0.7;
    }

    return false;
  }

  /**
   * Check if two markets are mutually exclusive
   */
  private areMutuallyExclusive(q1: string, q2: string): boolean {
    // Check for competing teams/candidates
    const vsPattern = /(.+) vs\.? (.+)/i;
    const match1 = q1.match(vsPattern);
    const match2 = q2.match(vsPattern);

    if (match1 && match2) {
      // Both are "X vs Y" - check if they're about the same matchup
      return true;
    }

    // Check for "will X win" patterns with different X
    const winPattern = /will (.+) win/i;
    const win1 = q1.match(winPattern);
    const win2 = q2.match(winPattern);

    if (win1 && win2 && win1[1] !== win2[1]) {
      // Check if they're in the same category (e.g., both presidential candidates)
      const sharedWords = this.getSharedSignificantWords(q1, q2);
      return sharedWords.length >= 2;  // At least 2 shared context words
    }

    return false;
  }

  /**
   * Check if q1 is a subset of q2 (more specific)
   */
  private isSubset(q1: string, q2: string): boolean {
    // Check for "by X" patterns (e.g., "win by 10+" is subset of "win")
    if (q1.includes(' by ') && !q2.includes(' by ')) {
      const base1 = q1.split(' by ')[0];
      return q2.includes(base1);
    }

    // Check for "before/by date" patterns
    if ((q1.includes(' before ') || q1.includes(' by ')) && !q2.includes(' before ') && !q2.includes(' by ')) {
      // More specific date constraint
      const sharedWords = this.getSharedSignificantWords(q1, q2);
      return sharedWords.length >= 3;
    }

    return false;
  }

  /**
   * Get shared significant words between two questions
   */
  private getSharedSignificantWords(q1: string, q2: string): string[] {
    const stopWords = new Set(['will', 'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'be', 'is', 'are']);
    const words1 = q1.split(/\s+/).filter((w) => w.length > 2 && !stopWords.has(w));
    const words2 = new Set(q2.split(/\s+/).filter((w) => w.length > 2 && !stopWords.has(w)));

    return words1.filter((w) => words2.has(w));
  }
}

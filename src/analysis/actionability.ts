/**
 * Actionability Analyzer
 *
 * Transforms market data from "informative" to "actionable" - answering:
 * "At this price, is this a buy, sell, or do-nothing — and what would change my mind?"
 */

import type { MarketState } from '../signals/types.js';
import type { PlaybookAnalysis, AlertSummary } from '../api/types.js';
import type {
  TradeFrame,
  AILean,
  SwingEvent,
  PriceZones,
  ZoneType,
  EdgeScore,
  DisagreementSignal,
  LabeledEvidence,
  EvidenceSummary,
  EvidenceImpact,
  EvidenceMagnitude,
  NextBestAction,
} from '../api/types.js';
import type { LinkedAlert } from '../signals/truth-change/types.js';

export interface ActionabilityInput {
  marketId: string;
  question: string;
  currentPrice: number;
  marketState?: MarketState;
  analysis?: PlaybookAnalysis;
  alerts: AlertSummary[];
  linkedAlerts?: LinkedAlert[];
}

/**
 * ActionabilityAnalyzer - Generates trading decision support data
 */
export class ActionabilityAnalyzer {
  // Time threshold for "priced in" vs "not priced in" (24 hours)
  private static readonly PRICED_IN_THRESHOLD_MS = 24 * 60 * 60 * 1000;

  // Volume spike threshold for disagreement detection
  private static readonly VOLUME_SPIKE_THRESHOLD = 3;

  /**
   * Generate complete trade frame for a market
   */
  generateTradeFrame(input: ActionabilityInput): TradeFrame {
    const { question, currentPrice, analysis, alerts, linkedAlerts } = input;
    const now = Date.now();

    // Determine AI lean from playbook recommendation and linked alerts
    const { lean, confidence, reasoning } = this.determineAILean(
      currentPrice,
      analysis,
      linkedAlerts
    );

    // Classify alerts as priced in or not
    const pricedIn: string[] = [];
    const notPricedIn: string[] = [];

    for (const alert of alerts.slice(0, 10)) {
      const age = now - alert.timestamp;
      const summary = this.summarizeAlert(alert);

      if (age > ActionabilityAnalyzer.PRICED_IN_THRESHOLD_MS) {
        pricedIn.push(summary);
      } else {
        notPricedIn.push(summary);
      }
    }

    // Add next event from playbook to not priced in
    if (analysis?.nextEvent) {
      notPricedIn.push(analysis.nextEvent.name);
    }

    // Generate swing events
    const swingEvents = this.generateSwingEvents(question, analysis, linkedAlerts);

    // Generate trade ideas based on current price and analysis
    const tradeIdeas = this.generateTradeIdeas(currentPrice, lean, analysis);

    return {
      lean,
      confidence,
      reasoning,
      pricedIn: pricedIn.slice(0, 5),
      notPricedIn: notPricedIn.slice(0, 5),
      swingEvents: swingEvents.slice(0, 4),
      tradeIdeas: tradeIdeas.slice(0, 3),
    };
  }

  /**
   * Determine AI lean from analysis and linked alerts
   */
  private determineAILean(
    currentPrice: number,
    analysis?: PlaybookAnalysis,
    linkedAlerts?: LinkedAlert[]
  ): { lean: AILean; confidence: number; reasoning: string } {
    // Default to neutral
    let lean: AILean = 'NEUTRAL';
    let confidence = 30;
    let reasoning = 'Insufficient data for directional view';

    // Use playbook recommendation if available
    if (analysis?.recommendation) {
      const rec = analysis.recommendation;

      // Map playbook action to lean
      if (rec.action === 'buy_yes' || rec.action === 'lean_yes') {
        lean = 'YES';
        confidence = Math.round(rec.confidence * 100);
        reasoning = rec.reasoning;
      } else if (rec.action === 'buy_no' || rec.action === 'lean_no') {
        lean = 'NO';
        confidence = Math.round(rec.confidence * 100);
        reasoning = rec.reasoning;
      } else if (rec.action === 'avoid' || rec.action === 'wait') {
        lean = 'NEUTRAL';
        confidence = Math.round(rec.confidence * 100);
        reasoning = rec.reasoning;
      } else {
        // watch or other actions
        confidence = Math.round(rec.confidence * 100);
        reasoning = rec.reasoning;
      }
    }

    // Incorporate linked alert signals
    if (linkedAlerts && linkedAlerts.length > 0) {
      let upSignals = 0;
      let downSignals = 0;

      for (const alert of linkedAlerts) {
        for (const affected of alert.affectedMarkets) {
          if (affected.expectedDirection === 'up') upSignals++;
          else if (affected.expectedDirection === 'down') downSignals++;
        }
      }

      // Adjust lean based on recent alerts if strong signal
      if (upSignals > downSignals + 1 && lean === 'NEUTRAL') {
        lean = 'YES';
        confidence = Math.min(confidence + 15, 85);
        reasoning = `Recent truth source events suggest upward pressure`;
      } else if (downSignals > upSignals + 1 && lean === 'NEUTRAL') {
        lean = 'NO';
        confidence = Math.min(confidence + 15, 85);
        reasoning = `Recent truth source events suggest downward pressure`;
      }
    }

    // Adjust reasoning for extreme prices
    if (currentPrice > 0.85 && lean === 'YES') {
      reasoning += ' (but high price limits upside)';
      confidence = Math.max(confidence - 10, 20);
    } else if (currentPrice < 0.15 && lean === 'NO') {
      reasoning += ' (but low price limits downside)';
      confidence = Math.max(confidence - 10, 20);
    }

    return { lean, confidence, reasoning };
  }

  /**
   * Summarize an alert for display
   */
  private summarizeAlert(alert: AlertSummary): string {
    // Extract key info from title, truncate if needed
    const title = alert.title || '';
    if (title.length <= 40) return title;

    // Try to extract the main point
    const parts = title.split(' - ');
    if (parts.length > 1) return parts[0].slice(0, 40);

    return title.slice(0, 37) + '...';
  }

  /**
   * Generate swing events that could move the market
   */
  private generateSwingEvents(
    question: string,
    analysis?: PlaybookAnalysis,
    linkedAlerts?: LinkedAlert[]
  ): SwingEvent[] {
    const events: SwingEvent[] = [];
    const questionLower = question.toLowerCase();

    // Add next event from playbook
    if (analysis?.nextEvent) {
      const isPositive = analysis.nextEvent.name.toLowerCase().includes('pass') ||
        analysis.nextEvent.name.toLowerCase().includes('approve') ||
        analysis.nextEvent.name.toLowerCase().includes('confirm');

      events.push({
        description: analysis.nextEvent.name,
        direction: isPositive ? 'up' : 'down',
        timing: this.formatEventTiming(analysis.nextEvent.timestamp),
      });
    }

    // Generate category-specific swing events
    if (questionLower.includes('shutdown') || questionLower.includes('funding')) {
      events.push({
        description: 'CR/omnibus passage',
        direction: 'down', // Reduces shutdown probability
        timing: 'any day',
      });
      events.push({
        description: 'Funding deadline miss',
        direction: 'up',
        timing: analysis?.countdown ? `${analysis.countdown.daysRemaining}d` : undefined,
      });
    } else if (questionLower.includes('hurricane') || questionLower.includes('storm')) {
      events.push({
        description: 'NHC upgrade',
        direction: 'up',
      });
      events.push({
        description: 'Track shift away',
        direction: 'down',
      });
    } else if (questionLower.includes('rate') || questionLower.includes('fed') || questionLower.includes('fomc')) {
      events.push({
        description: 'Hawkish Fed statement',
        direction: questionLower.includes('hike') || questionLower.includes('increase') ? 'up' : 'down',
      });
      events.push({
        description: 'Dovish Fed statement',
        direction: questionLower.includes('cut') || questionLower.includes('decrease') ? 'up' : 'down',
      });
    }

    // Add signals from linked alerts
    if (linkedAlerts) {
      for (const alert of linkedAlerts.slice(0, 2)) {
        const direction = alert.affectedMarkets.some(m => m.expectedDirection === 'up') ? 'up' : 'down';
        events.push({
          description: alert.headline.slice(0, 50),
          direction,
        });
      }
    }

    return events;
  }

  /**
   * Format event timing for display
   */
  private formatEventTiming(timestamp: number): string {
    const now = Date.now();
    const daysAway = Math.ceil((timestamp - now) / (1000 * 60 * 60 * 24));

    if (daysAway <= 0) return 'today';
    if (daysAway === 1) return 'tomorrow';
    if (daysAway <= 7) return `${daysAway}d`;

    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  /**
   * Generate specific trade ideas
   */
  private generateTradeIdeas(
    currentPrice: number,
    lean: AILean,
    analysis?: PlaybookAnalysis
  ): string[] {
    const ideas: string[] = [];

    // Price-based entry suggestions
    if (lean === 'YES') {
      if (currentPrice < 0.35) {
        ideas.push(`Buy YES here (${Math.round(currentPrice * 100)}¢)`);
      } else if (currentPrice < 0.50) {
        ideas.push(`Buy YES below ${Math.round(currentPrice * 100 - 5)}¢`);
      } else {
        ideas.push(`Wait for YES pullback below ${Math.round(currentPrice * 100 - 10)}¢`);
      }
    } else if (lean === 'NO') {
      if (currentPrice > 0.65) {
        ideas.push(`Buy NO here (${Math.round((1 - currentPrice) * 100)}¢)`);
      } else if (currentPrice > 0.50) {
        ideas.push(`Buy NO below ${Math.round((1 - currentPrice) * 100 - 5)}¢`);
      } else {
        ideas.push(`Wait for NO pullback below ${Math.round((1 - currentPrice) * 100 - 10)}¢`);
      }
    } else {
      ideas.push(`Wait for clearer signal before entry`);
    }

    // Add caveats from analysis
    if (analysis?.recommendation?.caveats) {
      const mainCaveat = analysis.recommendation.caveats[0];
      if (mainCaveat) {
        ideas.push(`Avoid if: ${mainCaveat.slice(0, 40)}`);
      }
    }

    return ideas;
  }

  /**
   * Calculate price zones for a market
   */
  calculatePriceZones(input: ActionabilityInput): PriceZones {
    const { currentPrice, marketState, analysis } = input;

    // Calculate historical bounds from price history
    let historicalLow = currentPrice;
    let historicalHigh = currentPrice;
    let sum = currentPrice;
    let count = 1;

    if (marketState?.priceHistory && marketState.priceHistory.length > 0) {
      for (const point of marketState.priceHistory) {
        if (point.price < historicalLow) historicalLow = point.price;
        if (point.price > historicalHigh) historicalHigh = point.price;
        sum += point.price;
        count++;
      }
    }

    const historicalMean = sum / count;
    const range = historicalHigh - historicalLow;

    // Define zones based on historical range
    // Attractive: bottom 35% of range
    // Fair: middle 30% of range
    // Crowded: top 35% of range
    let attractiveMax = historicalLow + range * 0.35;
    let crowdedMin = historicalHigh - range * 0.35;

    // Ensure zones make sense for extreme cases
    if (range < 0.1) {
      // Narrow range - use absolute thresholds
      attractiveMax = 0.35;
      crowdedMin = 0.65;
    }

    // Adjust zones based on playbook phase if available
    if (analysis?.phase) {
      switch (analysis.phase) {
        case 'imminent':
        case 'active':
          // During active events, shift zones
          attractiveMax = Math.min(attractiveMax + 0.05, 0.45);
          crowdedMin = Math.max(crowdedMin - 0.05, 0.55);
          break;
        case 'resolution':
          // Near resolution, wider zones
          attractiveMax = Math.min(attractiveMax + 0.10, 0.50);
          crowdedMin = Math.max(crowdedMin - 0.10, 0.50);
          break;
      }
    }

    // Determine current zone
    let currentZone: ZoneType;
    if (currentPrice <= attractiveMax) {
      currentZone = 'attractive';
    } else if (currentPrice >= crowdedMin) {
      currentZone = 'crowded';
    } else {
      currentZone = 'fair';
    }

    return {
      attractiveRange: { min: 0, max: Math.round(attractiveMax * 100) },
      fairRange: { min: Math.round(attractiveMax * 100), max: Math.round(crowdedMin * 100) },
      crowdedRange: { min: Math.round(crowdedMin * 100), max: 100 },
      currentPrice: Math.round(currentPrice * 100),
      currentZone,
      historicalLow: Math.round(historicalLow * 100),
      historicalHigh: Math.round(historicalHigh * 100),
      historicalMean: Math.round(historicalMean * 100),
    };
  }

  /**
   * Calculate edge score for a market
   * 0-100 composite: Information + Pricing + Timing + Liquidity (each 0-25)
   */
  calculateEdgeScore(input: ActionabilityInput): EdgeScore {
    const { marketState, analysis, alerts } = input;
    const zones = this.calculatePriceZones(input);

    // Information Edge (0-25)
    // +10 if playbook exists
    // +3 per recent alert (max 15)
    let information = 0;
    if (analysis && analysis.recommendation) {
      information += 10;
    }
    const recentAlerts = alerts.filter(
      a => Date.now() - a.timestamp < 7 * 24 * 60 * 60 * 1000
    ).length;
    information += Math.min(recentAlerts * 3, 15);
    information = Math.min(information, 25);

    // Pricing Edge (0-25)
    // +25 if in attractive zone
    // +15 if in fair zone
    // +5 if in crowded zone
    let pricing = 0;
    if (zones.currentZone === 'attractive') {
      pricing = 25;
    } else if (zones.currentZone === 'fair') {
      pricing = 15;
    } else {
      pricing = 5;
    }

    // Timing Edge (0-25)
    // +25 if event ≤1 day away
    // +20 if event ≤7 days
    // +15 if event ≤30 days
    // +5 otherwise
    let timing = 5;
    if (analysis?.countdown) {
      const days = analysis.countdown.daysRemaining;
      if (days <= 1) {
        timing = 25;
      } else if (days <= 7) {
        timing = 20;
      } else if (days <= 30) {
        timing = 15;
      }
    } else if (analysis?.nextEvent) {
      const daysUntil = Math.ceil(
        (analysis.nextEvent.timestamp - Date.now()) / (1000 * 60 * 60 * 24)
      );
      if (daysUntil <= 1) {
        timing = 25;
      } else if (daysUntil <= 7) {
        timing = 20;
      } else if (daysUntil <= 30) {
        timing = 15;
      }
    }

    // Liquidity Edge (0-25)
    // +15 if spread <2%
    // +10 if spread <5%
    // +10 if depth >1000
    // +5 if depth >100
    let liquidity = 0;
    if (marketState) {
      const spreadPercent = marketState.spread * 100;
      if (spreadPercent < 2) {
        liquidity += 15;
      } else if (spreadPercent < 5) {
        liquidity += 10;
      }

      const totalDepth = (marketState.bidDepth || 0) + (marketState.askDepth || 0);
      if (totalDepth > 1000) {
        liquidity += 10;
      } else if (totalDepth > 100) {
        liquidity += 5;
      }
    }
    liquidity = Math.min(liquidity, 25);

    const total = information + pricing + timing + liquidity;

    // Determine assessment
    let assessment: EdgeScore['assessment'];
    if (total >= 75) {
      assessment = 'Excellent';
    } else if (total >= 50) {
      assessment = 'Good';
    } else if (total >= 25) {
      assessment = 'Fair';
    } else {
      assessment = 'Poor';
    }

    return {
      total,
      components: {
        information,
        pricing,
        timing,
        liquidity,
      },
      assessment,
    };
  }

  /**
   * Detect disagreement signals (volume/price divergence)
   */
  detectDisagreementSignals(marketState?: MarketState): DisagreementSignal[] {
    const signals: DisagreementSignal[] = [];

    if (!marketState) return signals;

    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    // 1. High Volume + Flat Price (Absorption)
    if (marketState.volumeHistory && marketState.volumeHistory.length >= 10) {
      const recentVolume = marketState.volumeHistory
        .filter(v => v.timestamp > oneHourAgo)
        .reduce((sum, v) => sum + v.volume, 0);

      const olderVolume = marketState.volumeHistory
        .filter(v => v.timestamp <= oneHourAgo)
        .reduce((sum, v) => sum + v.volume, 0);

      const olderCount = marketState.volumeHistory.filter(v => v.timestamp <= oneHourAgo).length;
      const avgOlderVolume = olderCount > 0 ? olderVolume / olderCount : 0;

      if (avgOlderVolume > 0) {
        const volumeMultiple = recentVolume / (avgOlderVolume * Math.max(1, marketState.volumeHistory.filter(v => v.timestamp > oneHourAgo).length));

        // Check price change in same period
        const recentPrices = marketState.priceHistory.filter(p => p.timestamp > oneHourAgo);
        if (recentPrices.length >= 2) {
          const priceChange = Math.abs(
            recentPrices[recentPrices.length - 1].price - recentPrices[0].price
          );

          // High volume (>3x) but flat price (<1%)
          if (volumeMultiple > ActionabilityAnalyzer.VOLUME_SPIKE_THRESHOLD && priceChange < 0.01) {
            signals.push({
              type: 'high_volume_flat_price',
              severity: volumeMultiple > 5 ? 'high' : 'medium',
              description: `${volumeMultiple.toFixed(1)}x volume spike with minimal price impact`,
              implication: 'Informed traders may be accumulating or distributing quietly',
            });
          }
        }
      }
    }

    // 2. Flow Direction Mismatch
    if (marketState.recentTrades && marketState.recentTrades.length >= 5) {
      const recentTrades = marketState.recentTrades.slice(-20);

      // Calculate net flow
      let buyVolume = 0;
      let sellVolume = 0;
      for (const trade of recentTrades) {
        if (trade.side === 'BUY') buyVolume += trade.size;
        else sellVolume += trade.size;
      }

      const netFlow = buyVolume - sellVolume;
      const totalVolume = buyVolume + sellVolume;

      if (totalVolume > 0) {
        const flowRatio = Math.abs(netFlow) / totalVolume;

        // Strong directional flow (>60%)
        if (flowRatio > 0.6 && recentTrades.length >= 10) {
          const firstPrice = recentTrades[0].price;
          const lastPrice = recentTrades[recentTrades.length - 1].price;
          const priceChange = lastPrice - firstPrice;

          // Check for mismatch: net buying but price down, or net selling but price up
          const isBuying = netFlow > 0;
          const priceUp = priceChange > 0.005;
          const priceDown = priceChange < -0.005;

          if ((isBuying && priceDown) || (!isBuying && priceUp)) {
            signals.push({
              type: 'flow_direction_mismatch',
              severity: 'medium',
              description: `Net ${isBuying ? 'buying' : 'selling'} but price moving ${priceUp ? 'up' : 'down'}`,
              implication: isBuying
                ? 'Hidden selling pressure absorbing buys - possible distribution'
                : 'Hidden buying absorbing sells - possible accumulation',
            });
          }
        }
      }
    }

    // 3. Depth Imbalance (>3:1 ratio)
    if (marketState.bidDepth && marketState.askDepth) {
      const bidDepth = marketState.bidDepth;
      const askDepth = marketState.askDepth;

      if (bidDepth > 0 && askDepth > 0) {
        const ratio = bidDepth / askDepth;

        if (ratio > 3) {
          signals.push({
            type: 'depth_imbalance',
            severity: ratio > 5 ? 'high' : 'low',
            description: `${ratio.toFixed(1)}:1 bid/ask depth ratio`,
            implication: 'Strong bid support - may indicate informed buying interest',
          });
        } else if (ratio < 0.33) {
          signals.push({
            type: 'depth_imbalance',
            severity: ratio < 0.2 ? 'high' : 'low',
            description: `${(1 / ratio).toFixed(1)}:1 ask/bid depth ratio`,
            implication: 'Heavy ask pressure - may indicate informed selling interest',
          });
        }
      }
    }

    return signals;
  }

  /**
   * Label evidence/alerts with impact classification
   */
  labelEvidence(input: ActionabilityInput): {
    events: LabeledEvidence[];
    summary: EvidenceSummary;
  } {
    const { question, alerts } = input;
    const questionLower = question.toLowerCase();

    const events: LabeledEvidence[] = [];
    let positive = 0;
    let negative = 0;
    let context = 0;

    for (const alert of alerts.slice(0, 20)) {
      const { impact, magnitude, reasoning } = this.classifyAlertImpact(
        alert,
        questionLower
      );

      events.push({
        id: alert.id,
        timestamp: alert.timestamp,
        title: alert.title,
        body: alert.body,
        source: alert.source,
        impact,
        magnitude,
        impactReasoning: reasoning,
      });

      if (impact === 'positive') positive++;
      else if (impact === 'negative') negative++;
      else context++;
    }

    // Determine net direction
    let netDirection: EvidenceSummary['netDirection'];
    if (positive > negative + 1) {
      netDirection = 'bullish';
    } else if (negative > positive + 1) {
      netDirection = 'bearish';
    } else {
      netDirection = 'neutral';
    }

    return {
      events,
      summary: {
        positive,
        negative,
        context,
        netDirection,
      },
    };
  }

  /**
   * Classify a single alert's impact on the market
   */
  private classifyAlertImpact(
    alert: AlertSummary,
    questionLower: string
  ): { impact: EvidenceImpact; magnitude: EvidenceMagnitude; reasoning?: string } {
    const titleLower = (alert.title || '').toLowerCase();
    const bodyLower = (alert.body || '').toLowerCase();
    const combined = titleLower + ' ' + bodyLower;

    // Positive keywords (increase probability of YES)
    const positiveKeywords = [
      'pass', 'passed', 'approve', 'approved', 'agree', 'agreement',
      'confirm', 'confirmed', 'success', 'breakthrough', 'advance',
      'increase', 'upgrade', 'strengthen', 'support', 'win', 'victory',
    ];

    // Negative keywords (decrease probability of YES)
    const negativeKeywords = [
      'fail', 'failed', 'reject', 'rejected', 'block', 'blocked',
      'collapse', 'breakdown', 'stall', 'delay', 'oppose', 'opposition',
      'decrease', 'downgrade', 'weaken', 'lose', 'loss', 'defeat',
    ];

    // Context-only keywords
    const contextKeywords = [
      'update', 'meeting', 'schedule', 'comment', 'statement',
      'report', 'data', 'monitor', 'watch', 'await',
    ];

    // Count matches
    let positiveScore = 0;
    let negativeScore = 0;
    let contextScore = 0;

    for (const kw of positiveKeywords) {
      if (combined.includes(kw)) positiveScore++;
    }
    for (const kw of negativeKeywords) {
      if (combined.includes(kw)) negativeScore++;
    }
    for (const kw of contextKeywords) {
      if (combined.includes(kw)) contextScore++;
    }

    // Special handling for shutdown markets
    if (questionLower.includes('shutdown')) {
      // For shutdown markets, funding passage is NEGATIVE (reduces shutdown probability)
      if (combined.includes('pass') && (combined.includes('fund') || combined.includes('cr') || combined.includes('omnibus'))) {
        return {
          impact: 'negative',
          magnitude: 'major',
          reasoning: 'Funding passage reduces shutdown probability',
        };
      }
      // Funding failure is POSITIVE (increases shutdown probability)
      if (combined.includes('fail') && (combined.includes('fund') || combined.includes('vote'))) {
        return {
          impact: 'positive',
          magnitude: 'major',
          reasoning: 'Vote failure increases shutdown probability',
        };
      }
    }

    // Determine impact
    let impact: EvidenceImpact;
    let magnitude: EvidenceMagnitude;

    if (positiveScore > negativeScore + contextScore) {
      impact = 'positive';
      magnitude = positiveScore >= 2 ? 'major' : 'minor';
    } else if (negativeScore > positiveScore + contextScore) {
      impact = 'negative';
      magnitude = negativeScore >= 2 ? 'major' : 'minor';
    } else {
      impact = 'context';
      magnitude = 'minor';
    }

    // Boost magnitude for critical sources
    if (alert.priority === 'critical' || alert.priority === 'high') {
      magnitude = 'major';
    }

    return { impact, magnitude };
  }

  /**
   * Determine the next best action for the user
   */
  determineNextBestAction(
    input: ActionabilityInput,
    zones: PriceZones,
    edgeScore: EdgeScore
  ): NextBestAction {
    const { currentPrice, analysis } = input;

    // If edge score is poor, recommend avoiding
    if (edgeScore.total < 20) {
      return {
        action: 'avoid',
        label: '✕ Avoid',
        reasoning: 'Low edge score - insufficient information or poor setup',
      };
    }

    // If in crowded zone and no catalyst, recommend waiting
    if (zones.currentZone === 'crowded' && edgeScore.components.timing < 15) {
      const targetPrice = zones.fairRange.max / 100;
      return {
        action: 'wait',
        label: `⏳ Wait for pullback`,
        targetPrice,
        reasoning: `Price in crowded zone with no imminent catalyst - wait for ${zones.fairRange.max}% or lower`,
      };
    }

    // If in attractive zone with decent edge, recommend setting alert
    if (zones.currentZone === 'attractive' && edgeScore.total >= 40) {
      const targetPrice = (currentPrice + 0.05);
      return {
        action: 'set_alert',
        label: `🔔 Alert at ${Math.round(targetPrice * 100)}¢`,
        targetPrice,
        reasoning: `Good entry zone - set alert for breakout confirmation`,
      };
    }

    // If timing is excellent (imminent event), recommend monitoring
    if (edgeScore.components.timing >= 20) {
      const eventName = analysis?.countdown?.eventName || analysis?.nextEvent?.name || 'key event';
      return {
        action: 'monitor',
        label: `👁️ Monitor ${eventName}`,
        reasoning: `Event imminent - monitor closely for trading opportunity`,
      };
    }

    // Default: set alert at attractive zone entry
    const alertPrice = zones.attractiveRange.max / 100;
    return {
      action: 'set_alert',
      label: `🔔 Alert at ${zones.attractiveRange.max}¢`,
      targetPrice: alertPrice,
      reasoning: `Set alert for attractive zone entry at ${zones.attractiveRange.max}%`,
    };
  }

  /**
   * Generate complete actionability data for a market
   */
  analyze(input: ActionabilityInput): {
    tradeFrame: TradeFrame;
    priceZones: PriceZones;
    edgeScore: EdgeScore;
    disagreementSignals: DisagreementSignal[];
    labeledEvidence: { events: LabeledEvidence[]; summary: EvidenceSummary };
    nextBestAction: NextBestAction;
  } {
    const tradeFrame = this.generateTradeFrame(input);
    const priceZones = this.calculatePriceZones(input);
    const edgeScore = this.calculateEdgeScore(input);
    const disagreementSignals = this.detectDisagreementSignals(input.marketState);
    const labeledEvidence = this.labelEvidence(input);
    const nextBestAction = this.determineNextBestAction(input, priceZones, edgeScore);

    return {
      tradeFrame,
      priceZones,
      edgeScore,
      disagreementSignals,
      labeledEvidence,
      nextBestAction,
    };
  }
}

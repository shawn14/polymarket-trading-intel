/**
 * Edge Detector
 *
 * Proactively scans markets for mispricings by comparing truth source data
 * against current market prices. Detects edge when events occur but prices
 * haven't adjusted.
 *
 * Now includes whale edge detection - following smart money.
 */

import type { CongressClient } from '../ingestion/congress/client.js';
import type { WeatherClient } from '../ingestion/weather/client.js';
import type { FedClient } from '../ingestion/fed/client.js';
import type { SportsClient } from '../ingestion/sports/client.js';
import type { SportsEvent, InjuryReport } from '../ingestion/sports/types.js';
import { STAR_PLAYERS } from '../ingestion/sports/types.js';
import type { TruthMarketLinker } from '../signals/truth-change/linker.js';
import type { TrackedMarket } from '../signals/truth-change/types.js';
import type {
  EdgeOpportunity,
  EdgeScanResponse,
  ActiveWindows,
  WhaleEdgeOpportunity,
} from '../api/types.js';
import type { WhaleTracker, CachedWhaleTrade, WhaleInfo } from '../ingestion/whales/index.js';
import type { WhaleSignalType, WhaleAction, WhaleSignalParticipant } from '../ingestion/whales/types.js';
import { canEmitSignal, recordSignal, assessMarketQuality } from './market-quality.js';
import { COPY_THRESHOLD } from '../ingestion/whales/copy-score.js';

const HOUR = 60 * 60 * 1000;

// Whale edge detection thresholds
const ACCUMULATION_THRESHOLDS = {
  minWhaleSize: 20_000,        // $20k minimum
  minTradeCount: 3,            // 3+ trades
  maxWindowHours: 2,           // within 2h window
  minPriceLag: 0.03,           // price moved < 3% despite whale buying
};

const CONSENSUS_THRESHOLDS = {
  minWhaleCount: 3,            // 3+ distinct whales
  maxWindowHours: 4,           // within 4h window
  sameDirection: true,         // all buying same side
};

const EXIT_THRESHOLDS = {
  minPositionReduction: 0.50,  // 50%+ of position exited
  minPositionSize: 10_000,     // original position was $10k+
};

export interface EdgeDetectorDeps {
  congress: CongressClient | null;
  weather: WeatherClient;
  fed: FedClient;
  sports: SportsClient;
  linker: TruthMarketLinker;
  whaleTracker?: WhaleTracker;
}

// Event price cache entry - tracks price when an event occurred
interface EventPriceEntry {
  price: number;
  timestamp: number;
  eventDescription: string;
}

// Expected market impact from an event
interface EventImpact {
  direction: 'up' | 'down';
  magnitude: number; // Expected move (0.15 = 15%)
  description: string;
}

// Cached sports event with affected market prices
interface CachedSportsEvent {
  event: SportsEvent;
  timestamp: number;
  affectedMarkets: Map<string, number>; // marketId -> price at event time
}

export class EdgeDetector {
  private deps: EdgeDetectorDeps;
  private eventPriceCache: Map<string, EventPriceEntry> = new Map();
  private recentSportsEvents: CachedSportsEvent[] = [];
  private maxSportsEvents = 50; // Keep last 50 events
  private sportsEventMaxAge = 12 * HOUR; // Consider events up to 12 hours old

  // Whale edge detection
  private recentWhaleTrades: CachedWhaleTrade[] = [];
  private maxWhaleTrades = 500;
  private whaleTradeMaxAge = 4 * HOUR;

  constructor(deps: EdgeDetectorDeps) {
    this.deps = deps;
    this.setupSportsListener();
    this.setupWhaleListener();
  }

  /**
   * Listen to whale trades and cache them with market prices
   */
  private setupWhaleListener(): void {
    if (!this.deps.whaleTracker) return;

    this.deps.whaleTracker.on('whaleTrade', (trade) => {
      // Get current market price for this market
      const market = this.deps.linker.getTrackedMarkets().get(trade.marketId);
      const priceAtTrade = market?.currentPrices[0] ?? trade.price;

      this.recentWhaleTrades.push({
        trade,
        priceAtTrade,
        timestamp: Date.now(),
      });

      // Cleanup old trades
      this.cleanupWhaleTrades();

      console.log(`[EdgeDetector] Cached whale trade: ${trade.whale.name || trade.whale.address.slice(0, 8)} ${trade.side} $${trade.sizeUsdc.toFixed(0)} on ${trade.marketId.slice(0, 8)}`);
    });
  }

  /**
   * Cleanup old whale trades
   */
  private cleanupWhaleTrades(): void {
    const cutoff = Date.now() - this.whaleTradeMaxAge;

    this.recentWhaleTrades = this.recentWhaleTrades.filter(
      (ct) => ct.timestamp >= cutoff
    );

    if (this.recentWhaleTrades.length > this.maxWhaleTrades) {
      this.recentWhaleTrades = this.recentWhaleTrades.slice(-this.maxWhaleTrades);
    }
  }

  /**
   * Listen to sports events and cache them with market prices
   */
  private setupSportsListener(): void {
    this.deps.sports.on('event', (event: SportsEvent) => {
      // Only cache significant injury updates
      if (event.type !== 'injury_update') return;
      if (!event.injury) return;
      if (event.significance === 'low') return;

      // Get current prices for potentially affected markets
      const affectedMarkets = this.findAffectedSportsMarkets(event);

      // Cache the event with market prices at this moment
      this.recentSportsEvents.push({
        event,
        timestamp: Date.now(),
        affectedMarkets,
      });

      // Trim old events
      this.cleanupSportsEvents();

      console.log(`[EdgeDetector] Cached sports event: ${event.headline} (${affectedMarkets.size} markets)`);
    });
  }

  /**
   * Find markets that could be affected by a sports event
   */
  private findAffectedSportsMarkets(event: SportsEvent): Map<string, number> {
    const affected = new Map<string, number>();
    if (!event.injury) return affected;

    const trackedMarkets = this.deps.linker.getTrackedMarkets();
    const playerName = event.injury.player.toLowerCase();
    const teamName = event.injury.team.toLowerCase();
    const teamAbbr = event.injury.teamAbbr.toLowerCase();

    for (const [id, market] of trackedMarkets) {
      // Only check sports markets
      if (!market.truthMap.truthSources.includes('sports')) continue;

      const questionLower = market.question.toLowerCase();
      const descLower = (market.description || '').toLowerCase();
      const fullText = `${questionLower} ${descLower}`;

      // Check if market mentions the player or team
      let isRelevant = false;

      // Direct player mention (high relevance for player props)
      if (fullText.includes(playerName)) {
        isRelevant = true;
      }
      // Team mention (relevant for team outcome markets)
      else if (fullText.includes(teamName) || fullText.includes(teamAbbr)) {
        isRelevant = true;
      }

      if (isRelevant) {
        const currentPrice = market.currentPrices[0] ?? 0.5;
        affected.set(id, currentPrice);
      }
    }

    return affected;
  }

  /**
   * Clean up old sports events
   */
  private cleanupSportsEvents(): void {
    const cutoff = Date.now() - this.sportsEventMaxAge;

    // Remove old events
    this.recentSportsEvents = this.recentSportsEvents.filter(
      (e) => e.timestamp > cutoff
    );

    // Trim to max size
    if (this.recentSportsEvents.length > this.maxSportsEvents) {
      this.recentSportsEvents = this.recentSportsEvents.slice(-this.maxSportsEvents);
    }
  }

  /**
   * Main scan - find all current edge opportunities
   */
  scan(): EdgeScanResponse {
    const startTime = Date.now();
    const opportunities: EdgeOpportunity[] = [];
    const whaleOpportunities: WhaleEdgeOpportunity[] = [];
    const trackedMarkets = this.deps.linker.getTrackedMarkets();

    for (const [, market] of trackedMarkets) {
      // Truth source edge detection
      const edge = this.detectEdgeForMarket(market);
      if (edge) {
        opportunities.push(edge);
      }

      // Whale edge detection
      const whaleEdge = this.detectWhaleEdge(market);
      if (whaleEdge) {
        whaleOpportunities.push(whaleEdge);
      }
    }

    // Sort by urgency + magnitude (highest first)
    opportunities.sort((a, b) => this.urgencyScore(b) - this.urgencyScore(a));
    whaleOpportunities.sort((a, b) => this.whaleUrgencyScore(b) - this.whaleUrgencyScore(a));

    return {
      timestamp: Date.now(),
      lastScanDuration: Date.now() - startTime,
      opportunities,
      whaleOpportunities,
      activeWindows: this.getActiveWindows(),
    };
  }

  /**
   * Detect whale edge for a market
   */
  detectWhaleEdge(market: TrackedMarket): WhaleEdgeOpportunity | null {
    if (!this.deps.whaleTracker) return null;

    // Get whale trades for this market
    const marketTrades = this.recentWhaleTrades.filter(
      (ct) => ct.trade.marketId === market.marketId
    );

    if (marketTrades.length === 0) return null;

    // Check market quality - don't signal on garbage markets
    const quality = assessMarketQuality(
      market.marketId,
      50_000, // Default volume assumption - would need actual data
      0.05,   // Default spread assumption
      100     // Default trade count assumption
    );

    const canSignal = canEmitSignal(
      market.marketId,
      50_000,
      0.05,
      100
    );

    if (!canSignal.allowed) {
      return null;
    }

    // Try detection patterns in priority order
    const accumulation = this.detectAccumulation(market, marketTrades);
    if (accumulation) {
      recordSignal(market.marketId);
      return accumulation;
    }

    const consensus = this.detectConsensus(market, marketTrades);
    if (consensus) {
      recordSignal(market.marketId);
      return consensus;
    }

    const exit = this.detectExit(market, marketTrades);
    if (exit) {
      recordSignal(market.marketId);
      return exit;
    }

    return null;
  }

  /**
   * Detect accumulation pattern - whale building position
   */
  private detectAccumulation(
    market: TrackedMarket,
    trades: CachedWhaleTrade[]
  ): WhaleEdgeOpportunity | null {
    const now = Date.now();
    const windowStart = now - ACCUMULATION_THRESHOLDS.maxWindowHours * HOUR;

    // Filter to recent trades in window
    const recentTrades = trades.filter((ct) => ct.timestamp >= windowStart);
    if (recentTrades.length === 0) return null;

    // Group by whale + outcome
    const whalePositions = new Map<string, {
      whale: WhaleInfo;
      outcome: 'YES' | 'NO';
      trades: CachedWhaleTrade[];
      totalSize: number;
      avgEntry: number;
    }>();

    for (const ct of recentTrades) {
      const key = `${ct.trade.whale.address}:${ct.trade.outcome}`;
      const existing = whalePositions.get(key);

      if (existing) {
        existing.trades.push(ct);
        const newTotal = existing.totalSize + ct.trade.sizeUsdc;
        existing.avgEntry = (existing.avgEntry * existing.totalSize + ct.trade.price * ct.trade.sizeUsdc) / newTotal;
        existing.totalSize = newTotal;
      } else {
        whalePositions.set(key, {
          whale: ct.trade.whale,
          outcome: ct.trade.outcome,
          trades: [ct],
          totalSize: ct.trade.sizeUsdc,
          avgEntry: ct.trade.price,
        });
      }
    }

    // Find accumulation patterns
    for (const [, pos] of whalePositions) {
      if (pos.trades.length < ACCUMULATION_THRESHOLDS.minTradeCount) continue;
      if (pos.totalSize < ACCUMULATION_THRESHOLDS.minWhaleSize) continue;

      // Check price lag
      const currentPrice = market.currentPrices[0] ?? 0.5;
      const firstTradePrice = pos.trades[0].priceAtTrade;
      const priceMove = Math.abs(currentPrice - firstTradePrice);

      if (priceMove >= ACCUMULATION_THRESHOLDS.minPriceLag) continue; // Already priced in

      // Calculate expected move based on whale tier and size
      const expectedMove = this.estimateWhaleImpact(pos.whale.tier, pos.totalSize);
      const timeSinceFirst = (now - pos.trades[0].timestamp) / HOUR;

      // Build signal
      const participants: WhaleSignalParticipant[] = [{
        address: pos.whale.address,
        name: pos.whale.name,
        tier: pos.whale.tier,
        totalSize: pos.totalSize,
        avgEntry: pos.avgEntry,
        tradeCount: pos.trades.length,
        copySuitability: pos.whale.copySuitability,
      }];

      const action = this.determineWhaleAction('accumulation', pos.whale);

      return {
        marketId: market.marketId,
        question: market.question,
        currentPrice,
        expectedPrice: Math.max(0, Math.min(1, currentPrice + (pos.outcome === 'YES' ? expectedMove : -expectedMove))),
        source: 'whale',
        signalType: 'accumulation',
        direction: pos.outcome,
        magnitude: expectedMove,
        confidence: pos.whale.tier === 'top10' ? 'high' : pos.whale.tier === 'top50' ? 'medium' : 'low',
        whales: participants,
        totalWhaleSize: pos.totalSize,
        avgEntryPrice: pos.avgEntry,
        timeSinceFirst,
        action,
        reasoning: `${pos.whale.name || pos.whale.address.slice(0, 8)} accumulating ${pos.outcome}, $${pos.totalSize.toFixed(0)} in ${pos.trades.length} trades`,
        urgency: timeSinceFirst < 1 ? 'immediate' : timeSinceFirst < 2 ? 'hours' : 'day',
      };
    }

    return null;
  }

  /**
   * Detect consensus pattern - multiple whales agree
   */
  private detectConsensus(
    market: TrackedMarket,
    trades: CachedWhaleTrade[]
  ): WhaleEdgeOpportunity | null {
    const now = Date.now();
    const windowStart = now - CONSENSUS_THRESHOLDS.maxWindowHours * HOUR;

    // Filter to recent trades
    const recentTrades = trades.filter((ct) => ct.timestamp >= windowStart);
    if (recentTrades.length === 0) return null;

    // Group by outcome
    const yesBuyers = new Map<string, { whale: WhaleInfo; totalSize: number; avgEntry: number; trades: CachedWhaleTrade[] }>();
    const noBuyers = new Map<string, { whale: WhaleInfo; totalSize: number; avgEntry: number; trades: CachedWhaleTrade[] }>();

    for (const ct of recentTrades) {
      if (ct.trade.side !== 'BUY') continue; // Only count buys for consensus

      const map = ct.trade.outcome === 'YES' ? yesBuyers : noBuyers;
      const key = ct.trade.whale.address;
      const existing = map.get(key);

      if (existing) {
        const newTotal = existing.totalSize + ct.trade.sizeUsdc;
        existing.avgEntry = (existing.avgEntry * existing.totalSize + ct.trade.price * ct.trade.sizeUsdc) / newTotal;
        existing.totalSize = newTotal;
        existing.trades.push(ct);
      } else {
        map.set(key, {
          whale: ct.trade.whale,
          totalSize: ct.trade.sizeUsdc,
          avgEntry: ct.trade.price,
          trades: [ct],
        });
      }
    }

    // Check for consensus
    const checkConsensus = (
      buyers: Map<string, { whale: WhaleInfo; totalSize: number; avgEntry: number; trades: CachedWhaleTrade[] }>,
      outcome: 'YES' | 'NO'
    ): WhaleEdgeOpportunity | null => {
      if (buyers.size < CONSENSUS_THRESHOLDS.minWhaleCount) return null;

      const participants: WhaleSignalParticipant[] = [];
      let totalSize = 0;
      let weightedEntry = 0;
      let earliestTrade = now;

      for (const [, buyer] of buyers) {
        participants.push({
          address: buyer.whale.address,
          name: buyer.whale.name,
          tier: buyer.whale.tier,
          totalSize: buyer.totalSize,
          avgEntry: buyer.avgEntry,
          tradeCount: buyer.trades.length,
          copySuitability: buyer.whale.copySuitability,
        });
        totalSize += buyer.totalSize;
        weightedEntry += buyer.avgEntry * buyer.totalSize;

        for (const t of buyer.trades) {
          if (t.timestamp < earliestTrade) earliestTrade = t.timestamp;
        }
      }

      weightedEntry /= totalSize;
      const timeSinceFirst = (now - earliestTrade) / HOUR;

      const currentPrice = market.currentPrices[0] ?? 0.5;
      const expectedMove = this.estimateConsensusImpact(participants);

      // Determine action based on best copyable whale
      const bestCopyable = participants
        .filter((p) => p.copySuitability >= COPY_THRESHOLD)
        .sort((a, b) => b.copySuitability - a.copySuitability)[0];

      const action: WhaleAction = bestCopyable ? 'COPY' : 'WATCH';

      return {
        marketId: market.marketId,
        question: market.question,
        currentPrice,
        expectedPrice: Math.max(0, Math.min(1, currentPrice + (outcome === 'YES' ? expectedMove : -expectedMove))),
        source: 'whale',
        signalType: 'consensus',
        direction: outcome,
        magnitude: expectedMove,
        confidence: 'high', // Consensus is high confidence
        whales: participants,
        totalWhaleSize: totalSize,
        avgEntryPrice: weightedEntry,
        timeSinceFirst,
        action,
        reasoning: `${participants.length} whales forming consensus on ${outcome}, total $${totalSize.toFixed(0)}`,
        urgency: timeSinceFirst < 2 ? 'immediate' : timeSinceFirst < 4 ? 'hours' : 'day',
      };
    };

    // Check YES consensus first (more common)
    const yesConsensus = checkConsensus(yesBuyers, 'YES');
    if (yesConsensus) return yesConsensus;

    const noConsensus = checkConsensus(noBuyers, 'NO');
    if (noConsensus) return noConsensus;

    return null;
  }

  /**
   * Detect exit pattern - whale reducing position
   */
  private detectExit(
    market: TrackedMarket,
    trades: CachedWhaleTrade[]
  ): WhaleEdgeOpportunity | null {
    if (!this.deps.whaleTracker) return null;

    const now = Date.now();

    // Look for recent sells
    const recentSells = trades.filter(
      (ct) => ct.trade.side === 'SELL' && now - ct.timestamp < 2 * HOUR
    );

    for (const ct of recentSells) {
      // Check position reduction using position ledger
      const reduction = this.deps.whaleTracker.getPositionReduction(
        ct.trade.whale.address,
        ct.trade.marketId,
        ct.trade.outcome
      );

      if (reduction < EXIT_THRESHOLDS.minPositionReduction) continue;

      const currentPrice = market.currentPrices[0] ?? 0.5;
      const expectedMove = ct.trade.whale.tier === 'top10' ? 0.10 : 0.05;
      const timeSinceFirst = (now - ct.timestamp) / HOUR;

      const participants: WhaleSignalParticipant[] = [{
        address: ct.trade.whale.address,
        name: ct.trade.whale.name,
        tier: ct.trade.whale.tier,
        totalSize: ct.trade.sizeUsdc,
        avgEntry: ct.trade.price,
        tradeCount: 1,
        copySuitability: ct.trade.whale.copySuitability,
      }];

      return {
        marketId: market.marketId,
        question: market.question,
        currentPrice,
        expectedPrice: Math.max(0, Math.min(1, currentPrice - (ct.trade.outcome === 'YES' ? expectedMove : -expectedMove))),
        source: 'whale',
        signalType: 'exit',
        direction: ct.trade.outcome === 'YES' ? 'NO' : 'YES', // Opposite of exited position
        magnitude: expectedMove,
        confidence: ct.trade.whale.tier === 'top10' ? 'high' : 'medium',
        whales: participants,
        totalWhaleSize: ct.trade.sizeUsdc,
        avgEntryPrice: ct.trade.price,
        timeSinceFirst,
        action: 'FADE',
        reasoning: `${ct.trade.whale.name || ct.trade.whale.address.slice(0, 8)} exiting ${ct.trade.outcome} position (${(reduction * 100).toFixed(0)}% reduction)`,
        urgency: timeSinceFirst < 1 ? 'immediate' : 'hours',
      };
    }

    return null;
  }

  /**
   * Estimate expected price impact from whale activity
   */
  private estimateWhaleImpact(tier: 'top10' | 'top50' | 'tracked', size: number): number {
    // Rule-based estimates from the plan
    if (tier === 'top10') {
      if (size >= 100_000) return 0.15;
      if (size >= 50_000) return 0.10;
      return 0.05;
    }
    if (tier === 'top50') {
      if (size >= 50_000) return 0.08;
      if (size >= 20_000) return 0.05;
      return 0.03;
    }
    // Tracked but not top
    return 0.03;
  }

  /**
   * Estimate impact from consensus
   */
  private estimateConsensusImpact(participants: WhaleSignalParticipant[]): number {
    const top10Count = participants.filter((p) => p.tier === 'top10').length;
    const top50Count = participants.filter((p) => p.tier === 'top50').length;

    if (top10Count >= 3) return 0.20;
    if (top10Count >= 2 || (top10Count >= 1 && top50Count >= 2)) return 0.15;
    if (top50Count >= 3) return 0.12;
    return 0.08;
  }

  /**
   * Determine action recommendation based on signal type and whale
   */
  private determineWhaleAction(signalType: WhaleSignalType, whale: WhaleInfo): WhaleAction {
    if (signalType === 'exit') return 'FADE';
    if (signalType === 'fade') return 'WATCH';

    // For accumulation/consensus, check if copyable
    if (whale.copySuitability >= COPY_THRESHOLD) {
      return 'COPY';
    }

    return 'WATCH';
  }

  /**
   * Calculate urgency score for whale signals
   */
  private whaleUrgencyScore(opp: WhaleEdgeOpportunity): number {
    let score = 0;

    // Urgency component
    switch (opp.urgency) {
      case 'immediate':
        score += 100;
        break;
      case 'hours':
        score += 50;
        break;
      case 'day':
        score += 25;
        break;
    }

    // Signal type priority (consensus > accumulation > exit)
    switch (opp.signalType) {
      case 'consensus':
        score += 40;
        break;
      case 'accumulation':
        score += 30;
        break;
      case 'exit':
        score += 20;
        break;
    }

    // Size component
    score += Math.min(30, opp.totalWhaleSize / 10_000 * 10);

    // Confidence component
    switch (opp.confidence) {
      case 'high':
        score += 30;
        break;
      case 'medium':
        score += 15;
        break;
      case 'low':
        score += 5;
        break;
    }

    // Copyable whales bonus
    const copyableCount = opp.whales.filter((w) => w.copySuitability >= COPY_THRESHOLD).length;
    score += copyableCount * 10;

    return score;
  }

  /**
   * Get currently active monitoring windows
   */
  getActiveWindows(): ActiveWindows {
    const injuryReport: string[] = [];

    // Check each league for injury report window
    for (const league of ['NFL', 'NBA', 'MLB'] as const) {
      if (this.deps.sports.isInjuryReportWindow(league)) {
        injuryReport.push(league);
      }
    }

    // Hurricane season is June 1 - November 30
    const month = new Date().getMonth();
    const hurricaneSeason = month >= 5 && month <= 10;

    return {
      fomc: this.deps.fed.isFOMCDay(),
      injuryReport,
      hurricaneSeason,
    };
  }

  /**
   * Detect edge for a single market
   */
  private detectEdgeForMarket(market: TrackedMarket): EdgeOpportunity | null {
    const category = market.truthMap.category;

    switch (category) {
      case 'government_shutdown':
      case 'legislation':
      case 'appropriations':
        return this.detectCongressEdge(market);
      case 'hurricane':
      case 'weather':
        return this.detectWeatherEdge(market);
      case 'fed_rate':
        return this.detectFedEdge(market);
      case 'sports_outcome':
      case 'sports_player':
        return this.detectSportsEdge(market);
      default:
        return null;
    }
  }

  /**
   * Detect edge from Congress events (bill actions)
   */
  private detectCongressEdge(market: TrackedMarket): EdgeOpportunity | null {
    if (!this.deps.congress) return null;

    const bills = this.deps.congress.getTrackedBills();

    for (const [, bill] of bills) {
      const lastAction = bill.summary.latestAction;
      if (!lastAction) continue;

      const actionDate = new Date(lastAction.actionDate);
      const ageHours = (Date.now() - actionDate.getTime()) / HOUR;

      // Only consider actions from the last 24 hours
      if (ageHours > 24) continue;

      // Check if bill is relevant to this market
      if (!this.isBillRelevant(bill.summary.title, market)) continue;

      // Determine expected impact
      const impact = this.congressActionImpact(lastAction.text, market);
      if (!impact) continue;

      // Get price at event time (or current if we don't have cached)
      const currentPrice = market.currentPrices[0] ?? 0.5;
      const cacheKey = `${market.marketId}-${lastAction.actionDate}`;
      let priceAtEvent = currentPrice;

      // Check cache or use current
      const cached = this.eventPriceCache.get(cacheKey);
      if (cached) {
        priceAtEvent = cached.price;
      } else {
        // Cache current price for future reference
        this.eventPriceCache.set(cacheKey, {
          price: currentPrice,
          timestamp: actionDate.getTime(),
          eventDescription: lastAction.text,
        });
      }

      // Calculate actual move vs expected move
      const actualMove = currentPrice - priceAtEvent;
      const expectedMove = impact.direction === 'down' ? -impact.magnitude : impact.magnitude;

      // Edge exists if actual move is < 50% of expected
      if (Math.abs(actualMove) < Math.abs(expectedMove) * 0.5) {
        const remainingEdge = Math.abs(expectedMove) - Math.abs(actualMove);

        return {
          marketId: market.marketId,
          question: market.question,
          currentPrice,
          expectedPrice: Math.max(0, Math.min(1, priceAtEvent + expectedMove)),
          edge: {
            direction: impact.direction === 'down' ? 'NO' : 'YES',
            magnitude: remainingEdge,
            confidence: ageHours < 4 ? 'high' : ageHours < 12 ? 'medium' : 'low',
            source: 'congress',
            event: `${lastAction.text.slice(0, 50)}... (${ageHours.toFixed(0)}h ago)`,
            eventTimestamp: actionDate.getTime(),
            priceAtEvent,
            priceTarget: Math.max(0, Math.min(1, priceAtEvent + expectedMove)),
            timeWindow: 24 - ageHours,
          },
          action: impact.direction === 'down' ? 'BUY_NO' : 'BUY_YES',
          urgency: ageHours < 4 ? 'immediate' : ageHours < 12 ? 'hours' : 'day',
        };
      }
    }

    return null;
  }

  /**
   * Detect edge from Weather events
   */
  private detectWeatherEdge(_market: TrackedMarket): EdgeOpportunity | null {
    // Weather edge requires ACTUAL alerts (Hurricane Warning, etc.)
    // Not implemented yet - would need to track WeatherClient alerts
    return null;
  }

  /**
   * Detect edge from Fed events
   */
  private detectFedEdge(_market: TrackedMarket): EdgeOpportunity | null {
    // Fed edge requires ACTUAL announcements
    // Not implemented yet - would need to track FedClient events
    return null;
  }

  /**
   * Detect edge from Sports events
   *
   * Checks recent injury events to see if affected markets have priced in the news.
   * Only flags edge when:
   * 1. A significant injury event occurred recently (< 12 hours)
   * 2. The market hasn't moved enough to reflect the expected impact
   */
  private detectSportsEdge(market: TrackedMarket): EdgeOpportunity | null {
    const currentPrice = market.currentPrices[0] ?? 0.5;

    // Look through recent sports events for ones that affect this market
    for (const cached of this.recentSportsEvents) {
      const priceAtEvent = cached.affectedMarkets.get(market.marketId);
      if (priceAtEvent === undefined) continue;

      const event = cached.event;
      if (!event.injury) continue;

      const ageHours = (Date.now() - cached.timestamp) / HOUR;
      if (ageHours > 12) continue; // Too old

      // Calculate expected impact
      const impact = this.sportsEventImpact(event.injury, event.significance, market);
      if (!impact) continue;

      // Calculate actual move vs expected move
      const actualMove = currentPrice - priceAtEvent;
      const expectedMove = impact.direction === 'down' ? -impact.magnitude : impact.magnitude;

      // Edge exists if actual move is < 50% of expected
      if (Math.abs(actualMove) < Math.abs(expectedMove) * 0.5) {
        const remainingEdge = Math.abs(expectedMove) - Math.abs(actualMove);

        // Only flag if remaining edge is meaningful (> 3%)
        if (remainingEdge < 0.03) continue;

        const isStarPlayer = this.isStarPlayer(event.injury.player, event.injury.league);

        return {
          marketId: market.marketId,
          question: market.question,
          currentPrice,
          expectedPrice: Math.max(0, Math.min(1, priceAtEvent + expectedMove)),
          edge: {
            direction: impact.direction === 'down' ? 'NO' : 'YES',
            magnitude: remainingEdge,
            confidence: isStarPlayer && ageHours < 4 ? 'high' : ageHours < 6 ? 'medium' : 'low',
            source: 'sports',
            event: `${event.injury.player} ${event.injury.status.toUpperCase()} (${ageHours.toFixed(1)}h ago)`,
            eventTimestamp: cached.timestamp,
            priceAtEvent,
            priceTarget: Math.max(0, Math.min(1, priceAtEvent + expectedMove)),
            timeWindow: 12 - ageHours,
          },
          action: impact.direction === 'down' ? 'BUY_NO' : 'BUY_YES',
          urgency: ageHours < 2 ? 'immediate' : ageHours < 6 ? 'hours' : 'day',
        };
      }
    }

    return null;
  }

  /**
   * Calculate expected market impact from a sports injury event
   */
  private sportsEventImpact(
    injury: InjuryReport,
    significance: SportsEvent['significance'],
    market: TrackedMarket
  ): EventImpact | null {
    const isStarPlayer = this.isStarPlayer(injury.player, injury.league);
    const category = market.truthMap.category;
    const questionLower = market.question.toLowerCase();

    // Player prop markets (O/U points, yards, etc.)
    if (category === 'sports_player') {
      // If this is a prop for the injured player
      if (questionLower.includes(injury.player.toLowerCase())) {
        if (injury.status === 'out') {
          return {
            direction: 'down',
            magnitude: 0.80, // Player out = prop resolves NO/under
            description: `${injury.player} ruled OUT - prop likely resolves under`,
          };
        }
        if (injury.status === 'doubtful') {
          return {
            direction: 'down',
            magnitude: 0.30,
            description: `${injury.player} DOUBTFUL - reduced playing time expected`,
          };
        }
        if (injury.status === 'questionable') {
          return {
            direction: 'down',
            magnitude: 0.10,
            description: `${injury.player} QUESTIONABLE - uncertainty on availability`,
          };
        }
        // Status upgrade (was out/doubtful, now available/probable)
        if (injury.isUpdate && (injury.status === 'available' || injury.status === 'probable')) {
          if (injury.previousStatus === 'out' || injury.previousStatus === 'doubtful') {
            return {
              direction: 'up',
              magnitude: 0.25,
              description: `${injury.player} upgraded to ${injury.status.toUpperCase()}`,
            };
          }
        }
      }
    }

    // Team outcome markets (win championship, make playoffs, etc.)
    if (category === 'sports_outcome') {
      const teamInQuestion =
        questionLower.includes(injury.team.toLowerCase()) ||
        questionLower.includes(injury.teamAbbr.toLowerCase());

      if (!teamInQuestion) return null;

      // Star player out = team less likely to win
      if (isStarPlayer && injury.status === 'out') {
        return {
          direction: 'down',
          magnitude: significance === 'critical' ? 0.15 : 0.08,
          description: `Star player ${injury.player} OUT - team odds decrease`,
        };
      }

      // Star player upgraded = team more likely to win
      if (isStarPlayer && injury.isUpdate &&
          (injury.status === 'available' || injury.status === 'probable') &&
          (injury.previousStatus === 'out' || injury.previousStatus === 'doubtful')) {
        return {
          direction: 'up',
          magnitude: 0.10,
          description: `Star player ${injury.player} returning - team odds increase`,
        };
      }

      // Non-star player out with high significance
      if (!isStarPlayer && significance === 'high' && injury.status === 'out') {
        return {
          direction: 'down',
          magnitude: 0.05,
          description: `${injury.player} OUT - minor impact on team odds`,
        };
      }
    }

    return null;
  }

  /**
   * Check if a player is a star player
   */
  private isStarPlayer(playerName: string, league: string): boolean {
    const stars = STAR_PLAYERS[league as keyof typeof STAR_PLAYERS] || [];
    const nameLower = playerName.toLowerCase();
    return stars.some((star) => nameLower.includes(star.toLowerCase()));
  }

  /**
   * Check if a bill is relevant to a market
   */
  private isBillRelevant(billTitle: string, market: TrackedMarket): boolean {
    const titleLower = billTitle.toLowerCase();
    const keywords = market.truthMap.keywords || [];

    // Check if bill title matches any market keywords
    return keywords.some((kw) => titleLower.includes(kw.toLowerCase()));
  }

  /**
   * Determine expected market impact from a Congress action
   */
  private congressActionImpact(actionText: string, market: TrackedMarket): EventImpact | null {
    const textLower = actionText.toLowerCase();
    const category = market.truthMap.category;

    // Shutdown markets: bill progress = less likely shutdown
    if (category === 'government_shutdown') {
      if (textLower.includes('signed') || textLower.includes('became law') ||
          textLower.includes('enacted')) {
        return {
          direction: 'down',
          magnitude: 0.25,
          description: 'Funding bill enacted',
        };
      }

      if (textLower.includes('passed house') || textLower.includes('passed senate')) {
        return {
          direction: 'down',
          magnitude: 0.15,
          description: 'Bill passed one chamber',
        };
      }

      if (textLower.includes('failed') || textLower.includes('rejected') ||
          textLower.includes('motion to proceed failed')) {
        return {
          direction: 'up',
          magnitude: 0.15,
          description: 'Funding bill failed',
        };
      }
    }

    // Legislation markets: will X bill pass
    if (category === 'legislation') {
      if (textLower.includes('signed') || textLower.includes('became law')) {
        return {
          direction: 'up',
          magnitude: 0.30,
          description: 'Bill enacted',
        };
      }

      if (textLower.includes('passed')) {
        return {
          direction: 'up',
          magnitude: 0.10,
          description: 'Bill progressing',
        };
      }

      if (textLower.includes('failed') || textLower.includes('vetoed')) {
        return {
          direction: 'down',
          magnitude: 0.25,
          description: 'Bill failed',
        };
      }
    }

    return null;
  }

  /**
   * Calculate urgency score for sorting (higher = more urgent)
   */
  private urgencyScore(opp: EdgeOpportunity): number {
    let score = 0;

    // Urgency component
    switch (opp.urgency) {
      case 'immediate':
        score += 100;
        break;
      case 'hours':
        score += 50;
        break;
      case 'day':
        score += 25;
        break;
    }

    // Magnitude component (scale 0-50)
    score += opp.edge.magnitude * 50;

    // Confidence component
    switch (opp.edge.confidence) {
      case 'high':
        score += 30;
        break;
      case 'medium':
        score += 15;
        break;
      case 'low':
        score += 5;
        break;
    }

    // Action component (BUY signals rank higher than MONITOR)
    if (opp.action !== 'MONITOR') {
      score += 20;
    }

    return score;
  }

  /**
   * Clear old entries from the event price cache
   */
  cleanupCache(): void {
    const cutoff = Date.now() - 48 * HOUR;
    for (const [key, entry] of this.eventPriceCache) {
      if (entry.timestamp < cutoff) {
        this.eventPriceCache.delete(key);
      }
    }
    this.cleanupSportsEvents();
    this.cleanupWhaleTrades();
  }

  /**
   * Get count of cached sports events (for debugging)
   */
  getCachedSportsEventCount(): number {
    return this.recentSportsEvents.length;
  }

  /**
   * Get count of cached whale trades (for debugging)
   */
  getCachedWhaleTradeCount(): number {
    return this.recentWhaleTrades.length;
  }

  /**
   * Get whale edge stats (for debugging)
   */
  getWhaleEdgeStats(): { trades: number; uniqueWhales: number; uniqueMarkets: number } {
    const whales = new Set<string>();
    const markets = new Set<string>();

    for (const ct of this.recentWhaleTrades) {
      whales.add(ct.trade.whale.address);
      markets.add(ct.trade.marketId);
    }

    return {
      trades: this.recentWhaleTrades.length,
      uniqueWhales: whales.size,
      uniqueMarkets: markets.size,
    };
  }
}

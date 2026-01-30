/**
 * Truth-Market Linker
 *
 * Connects truth source events to affected Polymarket markets.
 * When a truth source (Congress, Weather, Fed, etc.) emits an event,
 * the linker finds relevant markets and generates actionable alerts.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { PolymarketClient } from '../../ingestion/polymarket/client.js';
import type { CongressClient } from '../../ingestion/congress/client.js';
import type { WeatherClient } from '../../ingestion/weather/client.js';
import type { FedClient } from '../../ingestion/fed/client.js';
import type { SportsClient } from '../../ingestion/sports/client.js';
import type { SportsEvent as SportsClientEvent } from '../../ingestion/sports/types.js';
import type { ParsedMarket } from '../../ingestion/polymarket/types.js';
import { parseMarket } from '../../ingestion/polymarket/types.js';
import type { BillStatusChange } from '../../ingestion/congress/types.js';
import type { WeatherEvent } from '../../ingestion/weather/types.js';
import type { FedEvent } from '../../ingestion/fed/types.js';
import type { WatchlistManager, WatchlistMatch } from '../../watchlist/index.js';
import type {
  TruthMap,
  TrackedMarket,
  LinkedAlert,
  AffectedMarket,
  CongressEvent,
  MarketCategory,
  TruthSourceEvent,
} from './types.js';
import {
  SHUTDOWN_TRUTH_MAP,
  LEGISLATION_TRUTH_MAP,
  FED_RATE_TRUTH_MAP,
  HURRICANE_TRUTH_MAP,
  SPORTS_PLAYER_TRUTH_MAP,
  SPORTS_OUTCOME_TRUTH_MAP,
} from './types.js';

export interface TruthMarketLinkerEvents {
  alert: [alert: LinkedAlert];
}

export class TruthMarketLinker extends EventEmitter<TruthMarketLinkerEvents> {
  private trackedMarkets: Map<string, TrackedMarket> = new Map();
  private polymarketClient: PolymarketClient | null = null;
  private marketRefreshInterval: NodeJS.Timeout | null = null;
  private watchlistManager: WatchlistManager | null = null;
  private watchlistOnly: boolean = false;

  constructor() {
    super();
  }

  /**
   * Set watchlist manager for targeted alerting
   * When set with watchlistOnly=true, only emit alerts for watched markets
   */
  setWatchlistManager(manager: WatchlistManager, watchlistOnly: boolean = false): void {
    this.watchlistManager = manager;
    this.watchlistOnly = watchlistOnly;
    console.log(`[Linker] Watchlist manager attached (watchlistOnly=${watchlistOnly})`);
  }

  /**
   * Attach to data sources
   */
  attach(options: {
    polymarket: PolymarketClient;
    congress?: CongressClient;
    weather?: WeatherClient;
    fed?: FedClient;
    sports?: SportsClient;
  }): void {
    this.polymarketClient = options.polymarket;

    // Listen to Congress events
    if (options.congress) {
      options.congress.on('billChange', (change) => {
        this.handleCongressEvent(change);
      });
      console.log('[Linker] Attached to Congress client');
    }

    // Listen to Weather events
    if (options.weather) {
      options.weather.on('alert', (event) => {
        this.handleWeatherEvent(event);
      });
      console.log('[Linker] Attached to Weather client');
    }

    // Listen to Fed events
    if (options.fed) {
      options.fed.on('event', (event) => {
        this.handleFedEvent(event);
      });
      console.log('[Linker] Attached to Fed client');
    }

    // Listen to Sports events
    if (options.sports) {
      options.sports.on('event', (event) => {
        this.handleSportsEvent(event);
      });
      console.log('[Linker] Attached to Sports client');
    }

    // Refresh markets periodically
    this.refreshMarkets();
    this.marketRefreshInterval = setInterval(
      () => this.refreshMarkets(),
      10 * 60 * 1000 // 10 minutes
    );

    console.log('[Linker] Truth-Market Linker initialized');
  }

  /**
   * Stop the linker
   */
  stop(): void {
    if (this.marketRefreshInterval) {
      clearInterval(this.marketRefreshInterval);
      this.marketRefreshInterval = null;
    }
  }

  /**
   * Filter affected markets through watchlist
   * Returns only watched markets if watchlistOnly is true
   */
  private filterThroughWatchlist(
    affectedMarkets: AffectedMarket[],
    event: TruthSourceEvent
  ): AffectedMarket[] {
    if (!this.watchlistManager) {
      return affectedMarkets;
    }

    // Find matching watched markets
    const matches = this.watchlistManager.findMatchingMarkets(event);
    const watchedMarketIds = new Set(matches.map(m => m.market.marketId));

    if (this.watchlistOnly) {
      // Only return markets that are in watchlist AND match keywords
      return affectedMarkets.filter(m => watchedMarketIds.has(m.marketId));
    }

    // Otherwise, boost relevance for watched markets
    return affectedMarkets.map(m => {
      if (watchedMarketIds.has(m.marketId)) {
        const match = matches.find(wm => wm.market.marketId === m.marketId);
        return {
          ...m,
          relevanceScore: Math.min(m.relevanceScore + 0.2, 1.0),
          reasoning: match?.matchedKeywords.length
            ? `${m.reasoning} [Watchlist: ${match.matchedKeywords.join(', ')}]`
            : m.reasoning,
        };
      }
      return m;
    });
  }

  /**
   * Check if alert meets minimum confidence for watched markets
   */
  private meetsWatchlistConfidence(
    affectedMarkets: AffectedMarket[],
    confidence: LinkedAlert['confidence']
  ): boolean {
    if (!this.watchlistManager || !this.watchlistOnly) {
      return true;
    }

    const confidenceLevel = { low: 1, medium: 2, high: 3, very_high: 4 };
    const alertLevel = confidenceLevel[confidence];

    // Check if any affected market's min confidence is met
    for (const affected of affectedMarkets) {
      const watched = this.watchlistManager.getMarket(affected.marketId);
      if (watched) {
        const minLevel = confidenceLevel[watched.minConfidence];
        if (alertLevel >= minLevel) {
          return true;
        }
      }
    }

    return affectedMarkets.length === 0 ? false : true;
  }

  /**
   * Get all tracked markets
   */
  getTrackedMarkets(): Map<string, TrackedMarket> {
    return new Map(this.trackedMarkets);
  }

  /**
   * Manually add a market to track with a custom truth map
   */
  trackMarket(market: ParsedMarket, truthMap: TruthMap): void {
    this.trackedMarkets.set(market.id, {
      marketId: market.id,
      conditionId: market.conditionId,
      question: market.question,
      slug: market.slug,
      description: market.description,
      tokenIds: market.tokenIds,
      currentPrices: market.outcomePrices,
      truthMap,
      lastUpdated: Date.now(),
    });
  }

  /**
   * Refresh market data and auto-categorize
   */
  private async refreshMarkets(): Promise<void> {
    if (!this.polymarketClient) return;

    try {
      const rawMarkets = await this.polymarketClient.fetchMarkets({
        active: true,
        closed: false,
        limit: 100,
      });

      let newCount = 0;
      let updateCount = 0;

      for (const raw of rawMarkets) {
        const market = parseMarket(raw);
        if (!market.question || market.tokenIds.length === 0) continue;

        const existing = this.trackedMarkets.get(market.id);

        if (existing) {
          // Update prices
          existing.currentPrices = market.outcomePrices;
          existing.lastUpdated = Date.now();
          updateCount++;
        } else {
          // Auto-categorize and add
          const truthMap = this.autoCategorizeMaket(market);
          if (truthMap) {
            this.trackedMarkets.set(market.id, {
              marketId: market.id,
              conditionId: market.conditionId,
              question: market.question,
              slug: market.slug,
              description: market.description,
              tokenIds: market.tokenIds,
              currentPrices: market.outcomePrices,
              truthMap,
              lastUpdated: Date.now(),
            });
            newCount++;
          }
        }
      }

      if (newCount > 0 || updateCount > 0) {
        console.log(`[Linker] Markets: ${newCount} new, ${updateCount} updated, ${this.trackedMarkets.size} total tracked`);
      }
    } catch (error) {
      console.error('[Linker] Failed to refresh markets:', error);
    }
  }

  /**
   * Check if text contains keyword (word boundary aware for single words)
   */
  private textMatchesKeyword(text: string, keyword: string): boolean {
    const kwLower = keyword.toLowerCase();
    const textLower = text.toLowerCase();

    // For multi-word keywords, use simple includes
    if (kwLower.includes(' ')) {
      return textLower.includes(kwLower);
    }

    // For single words, use word boundary matching
    const regex = new RegExp(`\\b${kwLower}\\b`, 'i');
    return regex.test(text);
  }

  /**
   * Auto-categorize a market based on its question and description
   */
  private autoCategorizeMaket(market: ParsedMarket): TruthMap | null {
    const text = `${market.question} ${market.description}`;

    // Check shutdown/appropriations (high priority)
    if (SHUTDOWN_TRUTH_MAP.keywords?.some((kw) => this.textMatchesKeyword(text, kw))) {
      return {
        marketId: market.id,
        ...SHUTDOWN_TRUTH_MAP,
      } as TruthMap;
    }

    // Check Fed rate markets
    if (FED_RATE_TRUTH_MAP.keywords?.some((kw) => this.textMatchesKeyword(text, kw))) {
      return {
        marketId: market.id,
        ...FED_RATE_TRUTH_MAP,
      } as TruthMap;
    }

    // Check hurricane/weather
    if (HURRICANE_TRUTH_MAP.keywords?.some((kw) => this.textMatchesKeyword(text, kw))) {
      return {
        marketId: market.id,
        ...HURRICANE_TRUTH_MAP,
      } as TruthMap;
    }

    // Check general legislation (more restrictive)
    if (LEGISLATION_TRUTH_MAP.keywords?.some((kw) => this.textMatchesKeyword(text, kw))) {
      return {
        marketId: market.id,
        ...LEGISLATION_TRUTH_MAP,
      } as TruthMap;
    }

    // Check sports player props (O/U, points, yards, etc.)
    if (SPORTS_PLAYER_TRUTH_MAP.keywords?.some((kw) => this.textMatchesKeyword(text, kw))) {
      return {
        marketId: market.id,
        ...SPORTS_PLAYER_TRUTH_MAP,
      } as TruthMap;
    }

    // Check sports outcomes (wins, championships)
    if (SPORTS_OUTCOME_TRUTH_MAP.keywords?.some((kw) => this.textMatchesKeyword(text, kw))) {
      return {
        marketId: market.id,
        ...SPORTS_OUTCOME_TRUTH_MAP,
      } as TruthMap;
    }

    // No match - don't track
    return null;
  }

  /**
   * Handle Congress bill change events
   */
  private handleCongressEvent(change: BillStatusChange): void {
    const event: CongressEvent = {
      type: 'congress',
      billChange: change,
      billId: `${change.bill.type} ${change.bill.number}`,
      billTitle: change.bill.title,
      actionType: change.action.type,
      actionText: change.action.text,
    };

    // Find affected markets
    let affectedMarkets = this.findAffectedMarkets(event);

    // Filter through watchlist
    affectedMarkets = this.filterThroughWatchlist(affectedMarkets, event);

    if (affectedMarkets.length === 0) {
      return; // No relevant markets (or none in watchlist)
    }

    // Determine confidence and urgency
    const confidence = this.calculateConfidence(change, affectedMarkets);
    const urgency = this.calculateUrgency(change);

    // Check if alert meets minimum confidence for watched markets
    if (!this.meetsWatchlistConfidence(affectedMarkets, confidence)) {
      return;
    }

    // Generate alert
    const alert: LinkedAlert = {
      id: randomUUID(),
      timestamp: Date.now(),
      sourceType: 'congress',
      sourceEvent: event,
      affectedMarkets,
      confidence,
      urgency,
      headline: this.generateHeadline(event, affectedMarkets),
      summary: this.generateSummary(event, change),
      implications: this.generateImplications(event, affectedMarkets),
    };

    this.emit('alert', alert);
  }

  /**
   * Handle Fed events
   */
  private handleFedEvent(event: FedEvent): void {
    // Build the source event for watchlist matching
    const sourceEvent: TruthSourceEvent = {
      type: 'fed',
      eventType: event.type === 'fomc_statement' ? 'statement' :
        event.type === 'fomc_minutes' ? 'minutes' :
        event.type === 'rate_decision' ? 'rate_decision' : 'speech',
      content: event.description,
      rateChange: event.rateChange,
    };

    // Find affected markets
    let affectedMarkets = this.findFedAffectedMarkets(event);

    // Filter through watchlist
    affectedMarkets = this.filterThroughWatchlist(affectedMarkets, sourceEvent);

    if (affectedMarkets.length === 0) {
      return;
    }

    // Determine confidence and urgency
    const confidence = event.significance === 'critical' ? 'very_high' :
      event.significance === 'high' ? 'high' : 'medium';
    const urgency = event.significance;

    // Check if alert meets minimum confidence for watched markets
    if (!this.meetsWatchlistConfidence(affectedMarkets, confidence)) {
      return;
    }

    // Generate alert
    const alert: LinkedAlert = {
      id: randomUUID(),
      timestamp: Date.now(),
      sourceType: 'fed',
      sourceEvent,
      affectedMarkets,
      confidence,
      urgency,
      headline: `Fed: ${event.title.slice(0, 50)}`,
      summary: event.description.slice(0, 200),
      implications: affectedMarkets.map((m) => {
        const arrow = m.expectedDirection === 'up' ? '↑' :
          m.expectedDirection === 'down' ? '↓' : '?';
        return `${arrow} ${m.question.slice(0, 50)}... (${(m.currentPrice * 100).toFixed(0)}%)`;
      }),
    };

    this.emit('alert', alert);
  }

  /**
   * Handle Sports events
   */
  private handleSportsEvent(event: SportsClientEvent): void {
    // Build the source event for watchlist matching
    const sourceEvent: TruthSourceEvent = {
      type: 'sports',
      league: event.league,
      eventType: event.type === 'injury_update' ? 'injury' : 'lineup',
      team: event.injury?.team,
      player: event.injury?.player,
      details: event.details,
    };

    // Find affected markets
    let affectedMarkets = this.findSportsAffectedMarkets(event);

    // Filter through watchlist
    affectedMarkets = this.filterThroughWatchlist(affectedMarkets, sourceEvent);

    if (affectedMarkets.length === 0) {
      return;
    }

    // Determine confidence and urgency
    const confidence = event.significance === 'critical' ? 'very_high' :
      event.significance === 'high' ? 'high' : 'medium';
    const urgency = event.significance;

    // Check if alert meets minimum confidence for watched markets
    if (!this.meetsWatchlistConfidence(affectedMarkets, confidence)) {
      return;
    }

    // Generate alert
    const alert: LinkedAlert = {
      id: randomUUID(),
      timestamp: Date.now(),
      sourceType: 'sports',
      sourceEvent,
      affectedMarkets,
      confidence,
      urgency,
      headline: event.headline,
      summary: event.details,
      implications: affectedMarkets.map((m) => {
        const arrow = m.expectedDirection === 'up' ? '↑' :
          m.expectedDirection === 'down' ? '↓' : '?';
        return `${arrow} ${m.question.slice(0, 50)}... (${(m.currentPrice * 100).toFixed(0)}%)`;
      }),
    };

    this.emit('alert', alert);
  }

  /**
   * Find markets affected by a Sports event
   */
  private findSportsAffectedMarkets(event: SportsClientEvent): AffectedMarket[] {
    const affected: AffectedMarket[] = [];

    if (!event.injury) return affected;

    const playerName = event.injury.player.toLowerCase();
    const teamName = event.injury.team.toLowerCase();
    const teamAbbr = event.injury.teamAbbr.toLowerCase();

    for (const [, market] of this.trackedMarkets) {
      const truthMap = market.truthMap;

      // Skip if not tracking sports
      if (!truthMap.truthSources.includes('sports')) continue;

      // Check if market mentions the player or team
      const questionLower = market.question.toLowerCase();
      const descLower = market.description.toLowerCase();
      const fullText = `${questionLower} ${descLower}`;

      let isRelevant = false;
      let relevanceScore = 0;

      // Direct player mention = high relevance
      if (fullText.includes(playerName)) {
        isRelevant = true;
        relevanceScore = 0.95;
      }
      // Team mention for injury of key player
      else if (
        (fullText.includes(teamName) || fullText.includes(teamAbbr)) &&
        event.significance === 'critical'
      ) {
        isRelevant = true;
        relevanceScore = 0.7;
      }

      if (isRelevant) {
        affected.push({
          marketId: market.marketId,
          conditionId: market.conditionId,
          question: market.question,
          slug: market.slug,
          currentPrice: market.currentPrices[0] ?? 0.5,
          relevanceScore,
          expectedDirection: this.predictSportsDirection(event, market),
          reasoning: this.generateSportsReasoning(event),
        });
      }
    }

    return affected.sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  /**
   * Predict market direction from Sports event
   */
  private predictSportsDirection(
    event: SportsClientEvent,
    market: TrackedMarket
  ): 'up' | 'down' | 'uncertain' {
    if (!event.injury) return 'uncertain';

    const questionLower = market.question.toLowerCase();
    const status = event.injury.status;

    // Player prop markets (O/U points, yards, etc.)
    if (market.truthMap.category === 'sports_player') {
      // Player ruled out = market likely resolves NO/Under
      if (status === 'out') return 'down';
      // Player available after being questionable = market should adjust up
      if (status === 'available' && event.injury.previousStatus) return 'up';
    }

    // Team outcome markets
    if (market.truthMap.category === 'sports_outcome') {
      // Star player out hurts team chances
      if (status === 'out' && event.significance === 'critical') {
        // Check if market is about the player's team winning
        const teamInQuestion =
          questionLower.includes(event.injury.team.toLowerCase()) ||
          questionLower.includes(event.injury.teamAbbr.toLowerCase());
        if (teamInQuestion) return 'down';
      }
    }

    return 'uncertain';
  }

  /**
   * Generate reasoning for Sports impact
   */
  private generateSportsReasoning(event: SportsClientEvent): string {
    if (!event.injury) return 'Sports update';

    const status = event.injury.status.toUpperCase();
    const change = event.injury.previousStatus
      ? ` (was ${event.injury.previousStatus.toUpperCase()})`
      : '';

    return `${event.injury.player} ${status}${change}`;
  }

  /**
   * Check if market question is actually about Fed rates
   */
  private isFedRateMarket(question: string): boolean {
    const qLower = question.toLowerCase();
    const fedRateTerms = [
      'federal reserve',
      'fed rate',
      'fed cut',
      'fed hike',
      'rate cut',
      'rate hike',
      'interest rate',
      'fomc',
      'powell',
      'basis point',
      'federal funds',
    ];
    return fedRateTerms.some((term) => qLower.includes(term));
  }

  /**
   * Find markets affected by a Fed event
   */
  private findFedAffectedMarkets(event: FedEvent): AffectedMarket[] {
    const affected: AffectedMarket[] = [];

    for (const [, market] of this.trackedMarkets) {
      const truthMap = market.truthMap;

      // Skip if not tracking Fed
      if (!truthMap.truthSources.includes('fed')) continue;

      // Skip if market question isn't actually about Fed rates
      if (!this.isFedRateMarket(market.question)) continue;

      // Check relevance
      let isRelevant = false;
      let relevanceScore = 0;

      if (truthMap.category === 'fed_rate') {
        if (event.type === 'fomc_statement' || event.type === 'rate_decision') {
          isRelevant = true;
          relevanceScore = 0.95;
        } else if (event.type === 'fomc_minutes') {
          isRelevant = true;
          relevanceScore = 0.7;
        }
      }

      if (isRelevant) {
        affected.push({
          marketId: market.marketId,
          conditionId: market.conditionId,
          question: market.question,
          slug: market.slug,
          currentPrice: market.currentPrices[0] ?? 0.5,
          relevanceScore,
          expectedDirection: this.predictFedDirection(event, market),
          reasoning: this.generateFedReasoning(event),
        });
      }
    }

    return affected.sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  /**
   * Predict market direction from Fed event
   */
  private predictFedDirection(
    event: FedEvent,
    market: TrackedMarket
  ): 'up' | 'down' | 'uncertain' {
    const questionLower = market.question.toLowerCase();

    // Rate cut markets
    if (questionLower.includes('cut') || questionLower.includes('lower')) {
      if (event.rateDecision === 'cut') return 'up';
      if (event.rateDecision === 'hike') return 'down';
      if (event.sentiment === 'dovish') return 'up';
      if (event.sentiment === 'hawkish') return 'down';
    }

    // Rate hike markets
    if (questionLower.includes('hike') || questionLower.includes('raise')) {
      if (event.rateDecision === 'hike') return 'up';
      if (event.rateDecision === 'cut') return 'down';
      if (event.sentiment === 'hawkish') return 'up';
      if (event.sentiment === 'dovish') return 'down';
    }

    return 'uncertain';
  }

  /**
   * Generate reasoning for Fed impact
   */
  private generateFedReasoning(event: FedEvent): string {
    if (event.rateDecision) {
      const change = event.rateChange ? ` (${event.rateChange > 0 ? '+' : ''}${event.rateChange}bp)` : '';
      return `Fed ${event.rateDecision}${change}`;
    }
    if (event.sentiment) {
      return `Fed ${event.sentiment} tone`;
    }
    return `FOMC ${event.type.replace('_', ' ')}`;
  }

  /**
   * Handle Weather alert events
   */
  private handleWeatherEvent(event: WeatherEvent): void {
    // Build the source event for watchlist matching
    const sourceEvent: TruthSourceEvent = {
      type: 'weather',
      alertType: event.event,
      region: event.areas.join(', '),
      severity: event.severity,
      headline: event.headline,
    };

    // Find affected markets
    let affectedMarkets = this.findWeatherAffectedMarkets(event);

    // Filter through watchlist
    affectedMarkets = this.filterThroughWatchlist(affectedMarkets, sourceEvent);

    if (affectedMarkets.length === 0) {
      return; // No relevant markets (or none in watchlist)
    }

    // Determine confidence and urgency
    const confidence = event.significance === 'critical' ? 'very_high' :
      event.significance === 'high' ? 'high' : 'medium';
    const urgency = event.significance;

    // Check if alert meets minimum confidence for watched markets
    if (!this.meetsWatchlistConfidence(affectedMarkets, confidence)) {
      return;
    }

    // Generate alert
    const alert: LinkedAlert = {
      id: randomUUID(),
      timestamp: Date.now(),
      sourceType: 'weather',
      sourceEvent,
      affectedMarkets,
      confidence,
      urgency,
      headline: `${event.event}: ${event.states.join(', ')}`,
      summary: event.headline,
      implications: affectedMarkets.map((m) => {
        const arrow = m.expectedDirection === 'up' ? '↑' :
          m.expectedDirection === 'down' ? '↓' : '?';
        return `${arrow} ${m.question.slice(0, 50)}... (${(m.currentPrice * 100).toFixed(0)}%)`;
      }),
    };

    this.emit('alert', alert);
  }

  /**
   * Find markets affected by a weather event
   */
  private findWeatherAffectedMarkets(event: WeatherEvent): AffectedMarket[] {
    const affected: AffectedMarket[] = [];

    for (const [, market] of this.trackedMarkets) {
      const truthMap = market.truthMap;

      // Skip if not tracking weather
      if (!truthMap.truthSources.includes('weather')) continue;

      // Check if event matches market keywords
      let isRelevant = false;
      let relevanceScore = 0;

      const eventText = `${event.event} ${event.headline}`.toLowerCase();
      const marketText = `${market.question} ${market.description}`.toLowerCase();

      // Check for hurricane/tropical keywords
      if (truthMap.category === 'hurricane') {
        if (
          eventText.includes('hurricane') ||
          eventText.includes('tropical storm') ||
          eventText.includes('tropical cyclone')
        ) {
          isRelevant = true;
          relevanceScore = 0.9;
        }
      }

      // Check weather keywords
      if (truthMap.keywords) {
        for (const kw of truthMap.keywords) {
          if (eventText.includes(kw.toLowerCase())) {
            isRelevant = true;
            relevanceScore = Math.max(relevanceScore, 0.7);
          }
        }
      }

      if (isRelevant) {
        affected.push({
          marketId: market.marketId,
          conditionId: market.conditionId,
          question: market.question,
          slug: market.slug,
          currentPrice: market.currentPrices[0] ?? 0.5,
          relevanceScore,
          expectedDirection: this.predictWeatherDirection(event, market),
          reasoning: this.generateWeatherReasoning(event),
        });
      }
    }

    return affected.sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  /**
   * Predict market direction from weather event
   */
  private predictWeatherDirection(
    event: WeatherEvent,
    market: TrackedMarket
  ): 'up' | 'down' | 'uncertain' {
    const category = market.truthMap.category;

    if (category === 'hurricane') {
      // Hurricane markets: warnings mean event more likely
      if (event.event.includes('Warning')) {
        return 'up';
      }
      if (event.event.includes('Watch')) {
        return 'up';
      }
    }

    return 'uncertain';
  }

  /**
   * Generate reasoning for weather impact
   */
  private generateWeatherReasoning(event: WeatherEvent): string {
    if (event.event.includes('Warning')) {
      return `${event.event} issued - event imminent`;
    }
    if (event.event.includes('Watch')) {
      return `${event.event} issued - event possible`;
    }
    return `NWS ${event.event} for affected areas`;
  }

  /**
   * Find markets affected by a Congress event
   */
  private findAffectedMarkets(event: CongressEvent): AffectedMarket[] {
    const affected: AffectedMarket[] = [];
    const billTitleLower = event.billTitle.toLowerCase();

    for (const [, market] of this.trackedMarkets) {
      const truthMap = market.truthMap;

      // Skip if not tracking Congress
      if (!truthMap.truthSources.includes('congress')) continue;

      // Check bill patterns
      let isRelevant = false;
      let relevanceScore = 0;

      if (truthMap.billPatterns) {
        for (const pattern of truthMap.billPatterns) {
          if (pattern.test(event.billTitle)) {
            isRelevant = true;
            relevanceScore = 0.8;
            break;
          }
        }
      }

      // Check keyword overlap - bill title must match market keywords
      if (!isRelevant && truthMap.keywords) {
        const matchingKeywords = truthMap.keywords.filter(
          (kw) => this.textMatchesKeyword(event.billTitle, kw)
        );
        if (matchingKeywords.length > 0) {
          isRelevant = true;
          relevanceScore = Math.min(0.5 + matchingKeywords.length * 0.1, 0.9);
        }
      }

      if (isRelevant) {
        affected.push({
          marketId: market.marketId,
          conditionId: market.conditionId,
          question: market.question,
          slug: market.slug,
          currentPrice: market.currentPrices[0] ?? 0.5,
          relevanceScore,
          expectedDirection: this.predictDirection(event, market),
          reasoning: this.generateReasoning(event, market),
        });
      }
    }

    // Sort by relevance
    affected.sort((a, b) => b.relevanceScore - a.relevanceScore);

    return affected;
  }

  /**
   * Predict expected price direction
   */
  private predictDirection(
    event: CongressEvent,
    market: TrackedMarket
  ): 'up' | 'down' | 'uncertain' {
    const category = market.truthMap.category;
    const actionType = event.actionType;
    const actionText = event.actionText.toLowerCase();

    // Shutdown markets
    if (category === 'government_shutdown') {
      // Bill progress = less likely shutdown
      if (actionType === 'BecameLaw' || actionText.includes('signed')) {
        return 'down'; // Shutdown less likely
      }
      if (actionText.includes('passed') || actionText.includes('enrolled')) {
        return 'down'; // Progress toward funding
      }
      if (actionText.includes('failed') || actionText.includes('rejected')) {
        return 'up'; // Shutdown more likely
      }
    }

    // Legislation markets (will X bill pass)
    if (category === 'legislation') {
      if (actionType === 'BecameLaw') return 'up';
      if (actionType === 'Floor' && actionText.includes('passed')) return 'up';
      if (actionText.includes('failed') || actionText.includes('vetoed')) return 'down';
    }

    return 'uncertain';
  }

  /**
   * Generate reasoning for market impact
   */
  private generateReasoning(event: CongressEvent, market: TrackedMarket): string {
    const actionType = event.actionType;
    const category = market.truthMap.category;

    if (category === 'government_shutdown') {
      if (actionType === 'BecameLaw') {
        return 'Funding bill enacted - shutdown averted';
      }
      if (actionType === 'Floor') {
        return 'Floor action indicates progress on funding';
      }
      if (actionType === 'President') {
        return 'Presidential action on funding legislation';
      }
    }

    return `${actionType} action on related legislation`;
  }

  /**
   * Calculate confidence based on event and market match
   */
  private calculateConfidence(
    change: BillStatusChange,
    markets: AffectedMarket[]
  ): LinkedAlert['confidence'] {
    const avgRelevance = markets.reduce((sum, m) => sum + m.relevanceScore, 0) / markets.length;

    if (change.significance === 'critical' && avgRelevance > 0.7) return 'very_high';
    if (change.significance === 'high' && avgRelevance > 0.5) return 'high';
    if (change.significance === 'medium' || avgRelevance > 0.3) return 'medium';
    return 'low';
  }

  /**
   * Calculate urgency from bill change
   */
  private calculateUrgency(change: BillStatusChange): LinkedAlert['urgency'] {
    if (change.significance === 'critical') return 'critical';
    if (change.significance === 'high') return 'high';
    if (change.significance === 'medium') return 'medium';
    return 'low';
  }

  /**
   * Generate alert headline
   */
  private generateHeadline(event: CongressEvent, markets: AffectedMarket[]): string {
    const marketNames = markets.slice(0, 2).map((m) => m.question.slice(0, 30));
    return `${event.billId}: ${event.actionType} → ${marketNames.join(', ')}...`;
  }

  /**
   * Generate alert summary
   */
  private generateSummary(event: CongressEvent, change: BillStatusChange): string {
    return `${event.billId} (${event.billTitle.slice(0, 50)}...) - ${event.actionText.slice(0, 100)}`;
  }

  /**
   * Generate implications list
   */
  private generateImplications(event: CongressEvent, markets: AffectedMarket[]): string[] {
    return markets.map((m) => {
      const direction = m.expectedDirection === 'up' ? '↑' : m.expectedDirection === 'down' ? '↓' : '?';
      return `${direction} ${m.question.slice(0, 50)}... (${(m.currentPrice * 100).toFixed(0)}% → ${m.reasoning})`;
    });
  }
}

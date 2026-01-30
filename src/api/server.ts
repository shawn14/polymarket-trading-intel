/**
 * API Server
 *
 * REST API for accessing system status, alerts, and market analysis.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { URL } from 'url';
import type { PolymarketClient } from '../ingestion/polymarket/client.js';
import type { CongressClient } from '../ingestion/congress/client.js';
import type { WeatherClient } from '../ingestion/weather/client.js';
import type { FedClient } from '../ingestion/fed/client.js';
import type { SportsClient } from '../ingestion/sports/client.js';
import type { SignalDetector } from '../signals/detector.js';
import type { TruthMarketLinker } from '../signals/truth-change/linker.js';
import type { AlertEngine } from '../alerts/engine.js';
import type { WatchlistManager, AddMarketInput, UpdateMarketInput } from '../watchlist/index.js';
import type { WhaleTracker } from '../ingestion/whales/index.js';
import { findPlaybook, getAllPlaybooks } from '../playbooks/index.js';
import type {
  SystemStatus,
  MarketSummary,
  AlertSummary,
  PlaybookAnalysis,
  KeyDatesResponse,
  HealthResponse,
  ErrorResponse,
  BrowseMarket,
  MarketDetail,
  MarketEventsResponse,
  RelatedMarketsResponse,
  RelatedMarket,
  ActionableMarketDetail,
  WhaleActivityResponse,
  WhaleInfoResponse,
  WhaleTradeResponse,
  WhalePositionResponse,
} from './types.js';
import { ActionabilityAnalyzer } from '../analysis/actionability.js';
import { EdgeDetector } from '../analysis/edge-detector.js';
import type { EdgeScanResponse } from './types.js';

export interface APIServerConfig {
  port: number;
  host?: string;
}

export interface APIServerDependencies {
  polymarket: PolymarketClient;
  congress: CongressClient | null;
  weather: WeatherClient | null;
  fed: FedClient | null;
  sports: SportsClient | null;
  detector: SignalDetector;
  linker: TruthMarketLinker;
  alertEngine: AlertEngine;
  watchlist?: WatchlistManager;
  whaleTracker?: WhaleTracker;
}

export class APIServer {
  private config: APIServerConfig;
  private deps: APIServerDependencies;
  private server: ReturnType<typeof createServer> | null = null;
  private startTime: number = Date.now();
  private recentAlerts: AlertSummary[] = [];
  private maxRecentAlerts = 100;
  private actionabilityAnalyzer = new ActionabilityAnalyzer();
  private edgeDetector: EdgeDetector;

  // Edge scan cache (refresh every 60s)
  private edgeScanCache: EdgeScanResponse | null = null;
  private lastEdgeScan = 0;
  private edgeCacheTTL = 60000; // 60 seconds

  // Metrics
  private metrics = {
    signalsDetected: 0,
    booksReceived: 0,
    pricesReceived: 0,
    tradesReceived: 0,
  };

  // Last update times
  private lastUpdates = {
    polymarket: 0,
    congress: 0,
    weather: 0,
    fed: 0,
    sports: 0,
  };

  // Connection errors
  private errors: Record<string, { message: string; time: number } | undefined> = {};

  constructor(config: APIServerConfig, deps: APIServerDependencies) {
    this.config = config;
    this.deps = deps;

    // Initialize edge detector with whale tracker
    this.edgeDetector = new EdgeDetector({
      congress: deps.congress,
      weather: deps.weather,
      fed: deps.fed,
      sports: deps.sports,
      linker: deps.linker,
      whaleTracker: deps.whaleTracker,
    });

    this.setupListeners();
  }

  /**
   * Start the API server
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));

      this.server.on('error', reject);

      this.server.listen(this.config.port, this.config.host || '0.0.0.0', () => {
        console.log(`[API] Server listening on port ${this.config.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the API server
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /**
   * Add an alert to the recent alerts list
   */
  addAlert(alert: AlertSummary): void {
    this.recentAlerts.unshift(alert);
    if (this.recentAlerts.length > this.maxRecentAlerts) {
      this.recentAlerts = this.recentAlerts.slice(0, this.maxRecentAlerts);
    }
  }

  private setupListeners(): void {
    // Track Polymarket events
    this.deps.polymarket.on('book', () => {
      this.metrics.booksReceived++;
      this.lastUpdates.polymarket = Date.now();
    });

    this.deps.polymarket.on('price', () => {
      this.metrics.pricesReceived++;
      this.lastUpdates.polymarket = Date.now();
    });

    this.deps.polymarket.on('trade', () => {
      this.metrics.tradesReceived++;
      this.lastUpdates.polymarket = Date.now();
    });

    this.deps.polymarket.on('error', (error) => {
      this.errors.polymarket = { message: error.message, time: Date.now() };
    });

    // Track Congress events
    if (this.deps.congress) {
      this.deps.congress.on('billChange', () => {
        this.lastUpdates.congress = Date.now();
      });

      this.deps.congress.on('error', (error) => {
        this.errors.congress = { message: error.message, time: Date.now() };
      });
    }

    // Track Weather events (if enabled)
    if (this.deps.weather) {
      this.deps.weather.on('alert', () => {
        this.lastUpdates.weather = Date.now();
      });

      this.deps.weather.on('error', (error) => {
        this.errors.weather = { message: error.message, time: Date.now() };
      });
    }

    // Track Fed events (if enabled)
    if (this.deps.fed) {
      this.deps.fed.on('event', () => {
        this.lastUpdates.fed = Date.now();
      });

      this.deps.fed.on('error', (error) => {
        this.errors.fed = { message: error.message, time: Date.now() };
      });
    }

    // Track Sports events (if enabled)
    if (this.deps.sports) {
      this.deps.sports.on('event', () => {
        this.lastUpdates.sports = Date.now();
      });

      this.deps.sports.on('error', (error) => {
        this.errors.sports = { message: error.message, time: Date.now() };
      });
    }

    // Track signals
    this.deps.detector.on('signal', () => {
      this.metrics.signalsDetected++;
    });

    // Track alerts
    this.deps.alertEngine.on('alert', (alert) => {
      this.addAlert({
        id: alert.id,
        timestamp: alert.timestamp,
        priority: alert.priority,
        source: alert.source.type,
        title: alert.title,
        body: alert.body,
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method || 'GET';

    try {
      switch (path) {
        case '/':
          // Serve dashboard HTML
          await this.serveDashboard(res);
          break;

        case '/api':
          this.sendJSON(res, this.getAPIInfo());
          break;

        case '/api/health':
          this.sendJSON(res, this.getHealth());
          break;

        case '/api/status':
          this.sendJSON(res, this.getStatus());
          break;

        case '/api/markets':
          this.sendJSON(res, this.getMarkets());
          break;

        case '/api/markets/all':
          this.sendJSON(res, this.getAllSubscribedMarkets());
          break;

        case '/api/markets/browse':
          this.sendJSON(res, await this.getBrowseMarkets());
          break;

        case '/api/alerts':
          const limit = parseInt(url.searchParams.get('limit') || '50', 10);
          this.sendJSON(res, this.getAlerts(limit));
          break;

        case '/api/analysis':
          const marketId = url.searchParams.get('market');
          if (marketId) {
            const analysis = await this.getMarketAnalysis(marketId);
            if (analysis) {
              this.sendJSON(res, analysis);
            } else {
              this.sendError(res, 404, 'Market not found', 'NOT_FOUND');
            }
          } else {
            this.sendJSON(res, await this.getAllAnalysis());
          }
          break;

        case '/api/dates':
          this.sendJSON(res, this.getKeyDates());
          break;

        case '/api/playbooks':
          this.sendJSON(res, this.getPlaybookInfo());
          break;

        case '/api/edge':
          this.sendJSON(res, this.getEdgeOpportunities());
          break;

        case '/api/whales':
          this.sendJSON(res, this.getWhaleActivity());
          break;

        case '/api/whales/trades':
          const tradeLimit = parseInt(url.searchParams.get('limit') || '50', 10);
          this.sendJSON(res, this.getRecentWhaleTrades(tradeLimit));
          break;

        case '/api/whales/feed':
        case '/api/whales/feed.xml':
        case '/feed/whales':
          this.sendRSS(res, this.getWhaleTradesFeed());
          break;

        case '/api/watchlist':
          if (method === 'GET') {
            this.sendJSON(res, this.getWatchlist());
          } else if (method === 'POST') {
            const body = await this.parseBody(req);
            const result = await this.addToWatchlist(body);
            if (result.error) {
              this.sendError(res, 400, result.error, 'INVALID_REQUEST');
            } else {
              this.sendJSON(res, result.data);
            }
          } else {
            this.sendError(res, 405, 'Method not allowed', 'METHOD_NOT_ALLOWED');
          }
          break;

        case '/api/watchlist/matches':
          this.sendJSON(res, this.getWatchlistMatches());
          break;

        case '/api/watchlist/suggest':
          const q = url.searchParams.get('q') || '';
          this.sendJSON(res, this.suggestWatchlistConfig(q));
          break;

        default:
          // Check for /api/market/:id pattern (detail panel endpoints)
          if (path.startsWith('/api/market/')) {
            const parts = path.slice('/api/market/'.length).split('/');
            const marketId = parts[0];
            const subpath = parts[1];

            if (marketId) {
              if (!subpath) {
                // GET /api/market/:id - full detail
                const detail = await this.getMarketDetail(marketId);
                if (detail) {
                  this.sendJSON(res, detail);
                } else {
                  this.sendError(res, 404, 'Market not found', 'NOT_FOUND');
                }
              } else if (subpath === 'events') {
                // GET /api/market/:id/events
                const events = this.getMarketEvents(marketId);
                this.sendJSON(res, events);
              } else if (subpath === 'related') {
                // GET /api/market/:id/related
                const related = this.getRelatedMarkets(marketId);
                this.sendJSON(res, related);
              } else if (subpath === 'actionable') {
                // GET /api/market/:id/actionable
                const actionable = await this.getActionableMarketDetail(marketId);
                if (actionable) {
                  this.sendJSON(res, actionable);
                } else {
                  this.sendError(res, 404, 'Market not found', 'NOT_FOUND');
                }
              } else {
                this.sendError(res, 404, 'Endpoint not found', 'NOT_FOUND');
              }
              break;
            }
          }

          // Check for /api/whales/positions pattern
          if (path.startsWith('/api/whales/positions')) {
            const walletParam = url.searchParams.get('wallet');
            if (walletParam) {
              this.sendJSON(res, this.getWhalePositions(walletParam));
            } else {
              this.sendError(res, 400, 'wallet parameter required', 'INVALID_REQUEST');
            }
            break;
          }

          // Check for /api/watchlist/:id pattern
          if (path.startsWith('/api/watchlist/')) {
            const marketId = path.slice('/api/watchlist/'.length);
            if (marketId && marketId !== 'matches' && marketId !== 'suggest') {
              if (method === 'PUT') {
                const body = await this.parseBody(req);
                const result = this.updateWatchlistMarket(marketId, body);
                if (result.error) {
                  this.sendError(res, 400, result.error, 'INVALID_REQUEST');
                } else if (!result.data) {
                  this.sendError(res, 404, 'Market not in watchlist', 'NOT_FOUND');
                } else {
                  this.sendJSON(res, result.data);
                }
              } else if (method === 'DELETE') {
                const removed = this.removeFromWatchlist(marketId);
                if (removed) {
                  this.sendJSON(res, { success: true, marketId });
                } else {
                  this.sendError(res, 404, 'Market not in watchlist', 'NOT_FOUND');
                }
              } else if (method === 'GET') {
                const market = this.getWatchlistMarket(marketId);
                if (market) {
                  this.sendJSON(res, market);
                } else {
                  this.sendError(res, 404, 'Market not in watchlist', 'NOT_FOUND');
                }
              } else {
                this.sendError(res, 405, 'Method not allowed', 'METHOD_NOT_ALLOWED');
              }
              break;
            }
          }
          this.sendError(res, 404, 'Endpoint not found', 'NOT_FOUND');
      }
    } catch (error) {
      console.error('[API] Error:', error);
      this.sendError(res, 500, 'Internal server error', 'INTERNAL_ERROR');
    }
  }

  private async serveDashboard(res: ServerResponse): Promise<void> {
    try {
      // Find the public directory relative to this file
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const htmlPath = join(__dirname, '..', '..', 'public', 'index.html');

      const html = await readFile(htmlPath, 'utf-8');
      res.setHeader('Content-Type', 'text/html');
      res.writeHead(200);
      res.end(html);
    } catch (error) {
      // Fallback to API info if dashboard not found
      this.sendJSON(res, this.getAPIInfo());
    }
  }

  private sendJSON(res: ServerResponse, data: unknown): void {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify(data, null, 2));
  }

  private sendRSS(res: ServerResponse, xml: string): void {
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.writeHead(200);
    res.end(xml);
  }

  private sendError(res: ServerResponse, status: number, message: string, code: string): void {
    const error: ErrorResponse = {
      error: message,
      code,
      timestamp: Date.now(),
    };
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(status);
    res.end(JSON.stringify(error));
  }

  private getAPIInfo(): object {
    return {
      name: 'Polymarket Trading Intelligence API',
      version: '0.2.0',
      endpoints: [
        { path: '/api/health', description: 'Health check' },
        { path: '/api/status', description: 'System status and metrics' },
        { path: '/api/markets', description: 'Tracked markets' },
        { path: '/api/markets/all', description: 'All subscribed markets' },
        { path: '/api/markets/browse', description: 'Browse all markets with categories, sources, and analysis' },
        { path: '/api/alerts', description: 'Recent alerts (use ?limit=N)' },
        { path: '/api/analysis', description: 'Playbook analysis (use ?market=ID for specific)' },
        { path: '/api/dates', description: 'Upcoming key dates' },
        { path: '/api/playbooks', description: 'Available playbooks' },
        { path: '/api/edge', description: 'Edge opportunities from truth source and whale analysis' },
        { path: '/api/whales', description: 'Whale activity overview with top traders and recent trades' },
        { path: '/api/whales/trades', description: 'Recent whale trades (use ?limit=N)' },
        { path: '/api/whales/positions', description: 'Whale positions (use ?wallet=ADDRESS)' },
        { path: '/api/watchlist', description: 'Watchlist management (GET, POST)' },
        { path: '/api/market/:id', description: 'Market detail panel data' },
        { path: '/api/market/:id/actionable', description: 'Actionable trading decision data' },
        { path: '/api/market/:id/events', description: 'Market-related alerts/events' },
        { path: '/api/market/:id/related', description: 'Related markets' },
      ],
    };
  }

  private getHealth(): HealthResponse {
    const checks = {
      polymarket: this.lastUpdates.polymarket > 0 || !this.errors.polymarket,
      congress: this.deps.congress ? (this.lastUpdates.congress > 0 || !this.errors.congress) : true,
      weather: this.lastUpdates.weather > 0 || !this.errors.weather,
      fed: this.lastUpdates.fed > 0 || !this.errors.fed,
      sports: !this.errors.sports,
    };

    const allHealthy = Object.values(checks).every((v) => v);
    const anyHealthy = Object.values(checks).some((v) => v);

    return {
      status: allHealthy ? 'healthy' : anyHealthy ? 'degraded' : 'unhealthy',
      checks,
      timestamp: Date.now(),
    };
  }

  private getStatus(): SystemStatus {
    const trackedMarkets = this.deps.linker.getTrackedMarkets();

    return {
      uptime: Date.now() - this.startTime,
      startedAt: new Date(this.startTime).toISOString(),
      version: '0.1.0',

      connections: {
        polymarket: {
          connected: this.lastUpdates.polymarket > 0,
          lastError: this.errors.polymarket?.message,
          lastErrorTime: this.errors.polymarket?.time,
        },
        congress: {
          connected: this.deps.congress !== null,
          lastError: this.errors.congress?.message,
          lastErrorTime: this.errors.congress?.time,
        },
        weather: {
          connected: true,
          lastError: this.errors.weather?.message,
          lastErrorTime: this.errors.weather?.time,
        },
        fed: {
          connected: true,
          lastError: this.errors.fed?.message,
          lastErrorTime: this.errors.fed?.time,
        },
        sports: {
          connected: true,
          lastError: this.errors.sports?.message,
          lastErrorTime: this.errors.sports?.time,
        },
      },

      metrics: {
        marketsTracked: trackedMarkets.size,
        marketsSubscribed: this.deps.detector.getAllMarketQuestions().size,
        alertsPerMinute: this.deps.alertEngine.getCurrentRate(),
        signalsDetected: this.metrics.signalsDetected,
        booksReceived: this.metrics.booksReceived,
        pricesReceived: this.metrics.pricesReceived,
        tradesReceived: this.metrics.tradesReceived,
      },

      lastUpdates: this.lastUpdates,
    };
  }

  private getMarkets(): MarketSummary[] {
    const trackedMarkets = this.deps.linker.getTrackedMarkets();
    const markets: MarketSummary[] = [];

    for (const [id, market] of trackedMarkets) {
      markets.push({
        id,
        conditionId: market.conditionId,
        question: market.question,
        slug: market.slug,
        category: market.truthMap.category,
        currentPrice: market.currentPrices[0] ?? 0.5,
        tokenIds: market.tokenIds,
        lastUpdated: market.lastUpdated,
      });
    }

    return markets.sort((a, b) => b.lastUpdated - a.lastUpdated);
  }

  private getAllSubscribedMarkets(): object[] {
    const marketQuestions = this.deps.detector.getAllMarketQuestions();
    const marketStates = this.deps.detector.getAllMarketStates();
    const markets: object[] = [];

    for (const [assetId, question] of marketQuestions) {
      const state = marketStates.get(assetId);
      markets.push({
        assetId,
        question,
        currentPrice: state?.currentPrice ?? 0.5,
        bestBid: state?.bestBid ?? 0,
        bestAsk: state?.bestAsk ?? 1,
        spread: state?.spread ?? 1,
        lastUpdated: state?.lastUpdate ?? 0,
        priceHistory: state?.priceHistory?.length ?? 0,
      });
    }

    // Sort by last update, most recent first
    return markets.sort((a: any, b: any) => b.lastUpdated - a.lastUpdated);
  }

  /**
   * Get all markets with combined data for browsing
   * Merges: subscribed markets, tracked markets (with truth maps), analysis, and watchlist status
   */
  private async getBrowseMarkets(): Promise<BrowseMarket[]> {
    try {
      const marketQuestions = this.deps.detector.getAllMarketQuestions();
      const marketStates = this.deps.detector.getAllMarketStates();
      const trackedMarkets = this.deps.linker.getTrackedMarkets();

      // Get watchlist market IDs for quick lookup
      const watchedIds = new Set<string>();
      if (this.deps.watchlist) {
        try {
          const watchlist = this.deps.watchlist.getWatchlist();
          for (const m of watchlist.markets) {
            watchedIds.add(m.marketId);
          }
        } catch (e) {
          console.error('[API] Error loading watchlist:', e);
        }
      }

      // Build analysis cache (only for tracked markets with playbooks)
      // Limit to first 50 to avoid performance issues
      const analysisCache = new Map<string, PlaybookAnalysis>();
      let analysisCount = 0;
      for (const [id] of trackedMarkets) {
        if (analysisCount >= 50) break;
        try {
          const analysis = await this.getMarketAnalysis(id);
          if (analysis) {
            analysisCache.set(id, analysis);
            analysisCount++;
          }
        } catch (e) {
          // Skip failed analysis
        }
      }

      const browseMarkets: BrowseMarket[] = [];

      // First, add all subscribed markets (from detector)
      for (const [assetId, question] of marketQuestions) {
        const state = marketStates.get(assetId);
        const tracked = trackedMarkets.get(assetId);
        const analysis = analysisCache.get(assetId);

        browseMarkets.push({
          id: assetId,
          question: question || 'Unknown',
          slug: tracked?.slug || '',
          currentPrice: state?.currentPrice ?? 0.5,
          spread: state?.spread ?? 1,
          category: tracked?.truthMap?.category || 'other',
          truthSources: tracked?.truthMap?.truthSources || [],
          keywords: tracked?.truthMap?.keywords || [],
          phase: analysis?.phase,
          urgency: analysis?.urgency,
          countdown: analysis?.countdown ? {
            eventName: analysis.countdown.eventName,
            daysRemaining: analysis.countdown.daysRemaining,
          } : undefined,
          isWatched: watchedIds.has(assetId),
        });
      }

      // Add tracked markets that might not be in subscribed list
      for (const [id, market] of trackedMarkets) {
        if (!marketQuestions.has(id)) {
          const analysis = analysisCache.get(id);
          browseMarkets.push({
            id,
            question: market.question || 'Unknown',
            slug: market.slug || '',
            currentPrice: market.currentPrices?.[0] ?? 0.5,
            spread: 0,
            category: market.truthMap?.category || 'other',
            truthSources: market.truthMap?.truthSources || [],
            keywords: market.truthMap?.keywords || [],
            phase: analysis?.phase,
            urgency: analysis?.urgency,
            countdown: analysis?.countdown ? {
              eventName: analysis.countdown.eventName,
              daysRemaining: analysis.countdown.daysRemaining,
            } : undefined,
            isWatched: watchedIds.has(id),
          });
        }
      }

      // Sort by urgency (critical first), then by price
      const urgencyOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      browseMarkets.sort((a, b) => {
        const urgA = urgencyOrder[a.urgency || 'low'] ?? 4;
        const urgB = urgencyOrder[b.urgency || 'low'] ?? 4;
        if (urgA !== urgB) return urgA - urgB;
        return b.currentPrice - a.currentPrice;
      });

      return browseMarkets;
    } catch (error) {
      console.error('[API] Error in getBrowseMarkets:', error);
      return [];
    }
  }

  private getAlerts(limit: number): AlertSummary[] {
    return this.recentAlerts.slice(0, Math.min(limit, this.maxRecentAlerts));
  }

  private async getMarketAnalysis(marketId: string): Promise<PlaybookAnalysis | null> {
    const trackedMarkets = this.deps.linker.getTrackedMarkets();
    const market = trackedMarkets.get(marketId);

    if (!market) return null;

    const playbook = findPlaybook(market.question, market.description);
    if (!playbook) {
      return {
        marketId,
        question: market.question,
        category: market.truthMap.category,
        phase: 'monitoring',
        urgency: 'low',
        signals: [],
        recommendation: {
          action: 'watch',
          confidence: 0.3,
          reasoning: 'No specialized playbook available for this market',
          caveats: ['Manual analysis recommended'],
        },
      };
    }

    const status = await playbook.analyze(
      marketId,
      market.question,
      market.currentPrices[0] ?? 0.5
    );

    return {
      marketId,
      question: market.question,
      category: status.category,
      phase: status.phase,
      urgency: status.urgency,
      countdown: status.countdown ? {
        eventName: status.countdown.eventName,
        daysRemaining: status.countdown.daysRemaining,
        hoursRemaining: status.countdown.hoursRemaining,
      } : undefined,
      signals: status.signals.map((s) => ({
        type: s.type,
        description: s.description,
        strength: s.strength,
      })),
      recommendation: status.recommendation ? {
        action: status.recommendation.action,
        confidence: status.recommendation.confidence,
        reasoning: status.recommendation.reasoning,
        caveats: status.recommendation.caveats,
      } : undefined,
      nextEvent: status.nextKeyEvent ? {
        name: status.nextKeyEvent.name,
        timestamp: status.nextKeyEvent.timestamp,
        description: status.nextKeyEvent.description,
      } : undefined,
    };
  }

  private async getAllAnalysis(): Promise<PlaybookAnalysis[]> {
    const trackedMarkets = this.deps.linker.getTrackedMarkets();
    const analyses: PlaybookAnalysis[] = [];

    for (const [id] of trackedMarkets) {
      const analysis = await this.getMarketAnalysis(id);
      if (analysis) {
        analyses.push(analysis);
      }
    }

    // Sort by urgency
    const urgencyOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    return analyses.sort((a, b) =>
      (urgencyOrder[a.urgency as keyof typeof urgencyOrder] ?? 3) -
      (urgencyOrder[b.urgency as keyof typeof urgencyOrder] ?? 3)
    );
  }

  private getKeyDates(): KeyDatesResponse {
    const playbooks = getAllPlaybooks();
    const allDates: KeyDatesResponse['dates'] = [];
    const now = Date.now();

    for (const playbook of playbooks) {
      const dates = playbook.getKeyDates();
      for (const date of dates) {
        allDates.push({
          category: playbook.category,
          name: date.name,
          timestamp: date.timestamp,
          description: date.description,
          impact: date.impact,
          daysUntil: Math.ceil((date.timestamp - now) / (1000 * 60 * 60 * 24)),
        });
      }
    }

    // Sort by timestamp
    allDates.sort((a, b) => a.timestamp - b.timestamp);

    return { dates: allDates.slice(0, 20) };
  }

  private getPlaybookInfo(): object {
    const playbooks = getAllPlaybooks();
    return {
      available: playbooks.map((p) => ({
        category: p.category,
        description: this.getPlaybookDescription(p.category),
      })),
    };
  }

  private getPlaybookDescription(category: string): string {
    switch (category) {
      case 'shutdown':
        return 'Government shutdown tracking - CR expirations, appropriations bills';
      case 'hurricane':
        return 'Hurricane tracking - NHC advisories, landfall predictions';
      case 'fed_decision':
        return 'Fed decision tracking - FOMC meetings, rate decisions';
      case 'sports_player':
      case 'sports_outcome':
        return 'Sports tracking - injury reports, lineup confirmations';
      default:
        return 'Unknown category';
    }
  }

  // Watchlist API methods

  private async parseBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (e) {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  private getWatchlist(): object {
    if (!this.deps.watchlist) {
      return { enabled: false, message: 'Watchlist not configured' };
    }
    const watchlist = this.deps.watchlist.getWatchlist();
    return {
      enabled: true,
      version: watchlist.version,
      markets: watchlist.markets,
      count: watchlist.markets.length,
      createdAt: watchlist.createdAt,
      updatedAt: watchlist.updatedAt,
    };
  }

  private getWatchlistMarket(marketId: string): object | null {
    if (!this.deps.watchlist) return null;
    const market = this.deps.watchlist.getMarket(marketId);
    return market || null;
  }

  private async addToWatchlist(body: any): Promise<{ data?: object; error?: string }> {
    if (!this.deps.watchlist) {
      return { error: 'Watchlist not configured' };
    }

    const input: AddMarketInput = {
      marketId: body.marketId,
      conditionId: body.conditionId || '',
      question: body.question,
      truthSources: body.truthSources,
      keywords: body.keywords,
      minConfidence: body.minConfidence,
      notes: body.notes,
    };

    if (!input.marketId || !input.question) {
      return { error: 'marketId and question are required' };
    }

    try {
      const market = this.deps.watchlist.addMarket(input);
      await this.deps.watchlist.save();
      return { data: market };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  private updateWatchlistMarket(marketId: string, body: any): { data?: object | null; error?: string } {
    if (!this.deps.watchlist) {
      return { error: 'Watchlist not configured' };
    }

    const updates: UpdateMarketInput = {};
    if (body.truthSources !== undefined) updates.truthSources = body.truthSources;
    if (body.keywords !== undefined) updates.keywords = body.keywords;
    if (body.minConfidence !== undefined) updates.minConfidence = body.minConfidence;
    if (body.notes !== undefined) updates.notes = body.notes;

    const market = this.deps.watchlist.updateMarket(marketId, updates);
    if (market) {
      this.deps.watchlist.save().catch(console.error);
    }
    return { data: market };
  }

  private removeFromWatchlist(marketId: string): boolean {
    if (!this.deps.watchlist) return false;
    const removed = this.deps.watchlist.removeMarket(marketId);
    if (removed) {
      this.deps.watchlist.save().catch(console.error);
    }
    return removed;
  }

  private getWatchlistMatches(): object {
    if (!this.deps.watchlist) {
      return { enabled: false, matches: [] };
    }

    // Get recent alerts and see which ones matched watchlist
    const recentWithMatches = this.recentAlerts
      .slice(0, 20)
      .filter((alert) => {
        // Check if any watched market was mentioned
        const watchlist = this.deps.watchlist!.getWatchlist();
        return watchlist.markets.some((m) =>
          alert.body?.toLowerCase().includes(m.question.toLowerCase().slice(0, 30))
        );
      });

    return {
      enabled: true,
      matches: recentWithMatches,
      count: recentWithMatches.length,
    };
  }

  private suggestWatchlistConfig(question: string): object {
    if (!this.deps.watchlist || !question) {
      return { truthSources: [], keywords: [], category: 'other' };
    }

    const detected = this.deps.watchlist.detectTruthSources(question);
    const keywords = this.deps.watchlist.suggestKeywords(question);

    return {
      category: detected.category,
      truthSources: detected.truthSources,
      keywords,
    };
  }

  // Market Detail Panel API methods

  /**
   * Get full market detail for the detail panel
   * Merges data from: SignalDetector state, TruthMarketLinker, Playbook analysis, Watchlist
   */
  private async getMarketDetail(marketId: string): Promise<MarketDetail | null> {
    // Try to find in tracked markets first (has richer data)
    const trackedMarkets = this.deps.linker.getTrackedMarkets();
    const tracked = trackedMarkets.get(marketId);

    // Also check detector state (has price/trade history)
    const marketState = this.deps.detector.getMarketState(marketId);
    const question = this.deps.detector.getMarketQuestion(marketId);

    // Need at least one source of data
    if (!tracked && !marketState && !question) {
      return null;
    }

    // Get watchlist status
    let isWatched = false;
    if (this.deps.watchlist) {
      const watchlist = this.deps.watchlist.getWatchlist();
      isWatched = watchlist.markets.some((m) => m.marketId === marketId);
    }

    // Get playbook analysis if available
    let analysis: PlaybookAnalysis | undefined;
    if (tracked) {
      const playbook = findPlaybook(tracked.question, tracked.description);
      if (playbook) {
        try {
          const status = await playbook.analyze(
            marketId,
            tracked.question,
            tracked.currentPrices[0] ?? 0.5
          );
          analysis = {
            marketId,
            question: tracked.question,
            category: status.category,
            phase: status.phase,
            urgency: status.urgency,
            countdown: status.countdown ? {
              eventName: status.countdown.eventName,
              daysRemaining: status.countdown.daysRemaining,
              hoursRemaining: status.countdown.hoursRemaining,
            } : undefined,
            signals: status.signals.map((s) => ({
              type: s.type,
              description: s.description,
              strength: s.strength,
            })),
            recommendation: status.recommendation ? {
              action: status.recommendation.action,
              confidence: status.recommendation.confidence,
              reasoning: status.recommendation.reasoning,
              caveats: status.recommendation.caveats,
            } : undefined,
            nextEvent: status.nextKeyEvent ? {
              name: status.nextKeyEvent.name,
              timestamp: status.nextKeyEvent.timestamp,
              description: status.nextKeyEvent.description,
            } : undefined,
          };
        } catch (e) {
          // Playbook analysis failed, continue without it
        }
      }
    }

    // Build the response
    const currentPrice = marketState?.currentPrice ?? tracked?.currentPrices[0] ?? 0.5;

    // Cap priceHistory at 500 points for performance
    const priceHistory = (marketState?.priceHistory ?? []).slice(-500).map((p) => ({
      price: p.price,
      timestamp: p.timestamp,
    }));

    // Cap recentTrades at 50 for performance
    const recentTrades = (marketState?.recentTrades ?? []).slice(-50).map((t) => ({
      price: t.price,
      size: t.size,
      side: t.side as 'BUY' | 'SELL',
      timestamp: t.timestamp,
    }));

    return {
      id: marketId,
      conditionId: tracked?.conditionId ?? '',
      question: tracked?.question ?? question ?? 'Unknown',
      description: tracked?.description ?? '',
      slug: tracked?.slug ?? '',

      currentPrice,
      yesPrice: currentPrice,
      noPrice: 1 - currentPrice,
      impliedProbability: currentPrice,

      spread: marketState?.spread ?? 0,
      bestBid: marketState?.bestBid ?? 0,
      bestAsk: marketState?.bestAsk ?? 1,
      bidDepth: marketState?.bidDepth ?? 0,
      askDepth: marketState?.askDepth ?? 0,

      priceHistory,
      recentTrades,

      category: tracked?.truthMap?.category ?? 'other',
      truthSources: tracked?.truthMap?.truthSources ?? [],
      keywords: tracked?.truthMap?.keywords ?? [],

      analysis,

      lastUpdated: marketState?.lastUpdate ?? tracked?.lastUpdated ?? Date.now(),
      isWatched,
    };
  }

  /**
   * Get alerts/events related to a specific market
   * Filters recentAlerts by checking if the market was mentioned
   */
  private getMarketEvents(marketId: string): MarketEventsResponse {
    const trackedMarkets = this.deps.linker.getTrackedMarkets();
    const tracked = trackedMarkets.get(marketId);
    const question = tracked?.question ?? this.deps.detector.getMarketQuestion(marketId) ?? '';

    // Filter alerts that mention this market
    // Check by marketId in body or by question match
    const events = this.recentAlerts.filter((alert) => {
      const bodyLower = (alert.body ?? '').toLowerCase();
      const titleLower = (alert.title ?? '').toLowerCase();
      const questionLower = question.toLowerCase().slice(0, 40);

      return (
        bodyLower.includes(marketId) ||
        (questionLower && (bodyLower.includes(questionLower) || titleLower.includes(questionLower)))
      );
    });

    return {
      marketId,
      events,
      totalCount: events.length,
    };
  }

  /**
   * Get actionable market detail for trading decisions
   * Combines market data with actionability analysis
   */
  private async getActionableMarketDetail(marketId: string): Promise<ActionableMarketDetail | null> {
    // First get the base market detail
    const detail = await this.getMarketDetail(marketId);
    if (!detail) return null;

    // Get market state for analysis
    const marketState = this.deps.detector.getMarketState(marketId);

    // Get market-related alerts
    const marketEvents = this.getMarketEvents(marketId);

    // Run actionability analysis
    const actionability = this.actionabilityAnalyzer.analyze({
      marketId,
      question: detail.question,
      currentPrice: detail.currentPrice,
      marketState,
      analysis: detail.analysis,
      alerts: marketEvents.events,
    });

    // Combine detail with actionability data
    return {
      ...detail,
      tradeFrame: actionability.tradeFrame,
      priceZones: actionability.priceZones,
      edgeScore: actionability.edgeScore,
      disagreementSignals: actionability.disagreementSignals,
      labeledEvidence: actionability.labeledEvidence,
      nextBestAction: actionability.nextBestAction,
    };
  }

  /**
   * Get markets related to a specific market
   * Returns markets with same category and/or shared keywords
   */
  private getRelatedMarkets(marketId: string): RelatedMarketsResponse {
    const trackedMarkets = this.deps.linker.getTrackedMarkets();
    const marketQuestions = this.deps.detector.getAllMarketQuestions();
    const marketStates = this.deps.detector.getAllMarketStates();

    const target = trackedMarkets.get(marketId);
    const targetCategory = target?.truthMap?.category ?? 'other';
    const targetKeywords = new Set(target?.truthMap?.keywords ?? []);

    const sameCategory: RelatedMarket[] = [];
    const sharedKeywords: RelatedMarket[] = [];

    // Iterate through all tracked markets
    for (const [id, market] of trackedMarkets) {
      if (id === marketId) continue;

      const state = marketStates.get(id);
      const currentPrice = state?.currentPrice ?? market.currentPrices?.[0] ?? 0.5;

      // Check same category
      if (market.truthMap?.category === targetCategory && targetCategory !== 'other') {
        sameCategory.push({
          id,
          question: market.question,
          currentPrice,
          category: market.truthMap.category,
          urgency: undefined, // Could add playbook check here but expensive
        });
      }

      // Check shared keywords (at least 2 shared)
      const marketKeywords = market.truthMap?.keywords ?? [];
      const shared = marketKeywords.filter((k) => targetKeywords.has(k));

      if (shared.length >= 2) {
        sharedKeywords.push({
          id,
          question: market.question,
          currentPrice,
          category: market.truthMap?.category ?? 'other',
          sharedKeywords: shared,
        });
      }
    }

    // Also check subscribed markets that might not be in tracked
    for (const [assetId, question] of marketQuestions) {
      if (assetId === marketId || trackedMarkets.has(assetId)) continue;

      const state = marketStates.get(assetId);
      const currentPrice = state?.currentPrice ?? 0.5;

      // Simple keyword matching for non-tracked markets
      const questionLower = question.toLowerCase();
      const keywordMatches: string[] = [];
      for (const keyword of targetKeywords) {
        if (questionLower.includes(keyword.toLowerCase())) {
          keywordMatches.push(keyword);
        }
      }

      if (keywordMatches.length >= 2) {
        sharedKeywords.push({
          id: assetId,
          question,
          currentPrice,
          category: 'other',
          sharedKeywords: keywordMatches,
        });
      }
    }

    // Limit results
    return {
      marketId,
      sameCategory: sameCategory.slice(0, 10),
      sharedKeywords: sharedKeywords.slice(0, 10),
    };
  }

  /**
   * Get edge opportunities from truth source analysis
   * Results are cached for 60 seconds to avoid expensive rescans
   */
  private getEdgeOpportunities(): EdgeScanResponse {
    const now = Date.now();

    // Return cached result if still valid
    if (this.edgeScanCache && now - this.lastEdgeScan < this.edgeCacheTTL) {
      return this.edgeScanCache;
    }

    // Run fresh scan
    this.edgeScanCache = this.edgeDetector.scan();
    this.lastEdgeScan = now;

    // Periodically clean up old cache entries
    if (Math.random() < 0.1) {
      this.edgeDetector.cleanupCache();
    }

    return this.edgeScanCache;
  }

  // ============================================================================
  // Whale Intelligence API Methods
  // ============================================================================

  /**
   * Get whale activity overview
   */
  private getWhaleActivity(): WhaleActivityResponse | { enabled: false; message: string } {
    if (!this.deps.whaleTracker) {
      return { enabled: false, message: 'Whale tracking not configured' };
    }

    const whales = this.deps.whaleTracker.getAllWhales();
    const recentTrades = this.deps.whaleTracker.getRecentWhaleTrades(20);
    const edgeScan = this.getEdgeOpportunities();
    const stats = this.deps.whaleTracker.getStats();

    // Convert whales to response format
    const topWhales: WhaleInfoResponse[] = whales
      .sort((a, b) => b.volume7d - a.volume7d)
      .slice(0, 20)
      .map((w) => ({
        address: w.address,
        name: w.name,
        tier: w.tier,
        pnl7d: w.pnl7d,
        pnl30d: w.pnl30d,
        volume7d: w.volume7d,
        volume30d: w.volume30d,
        tradeCount7d: w.tradeCount7d,
        tradeCount30d: w.tradeCount30d,
        earlyEntryScore: w.earlyEntryScore,
        copySuitability: w.copySuitability,
        lastSeen: w.lastSeen,
      }));

    // Convert trades to response format and sort by timestamp descending (most recent first)
    const trades: WhaleTradeResponse[] = recentTrades
      .map((ct) => ({
        whaleAddress: ct.trade.whale.address,
        whaleName: ct.trade.whale.name,
        whaleTier: ct.trade.whale.tier,
        marketId: ct.trade.marketId,
        marketTitle: ct.trade.marketTitle,
        marketSlug: ct.trade.marketSlug,
        side: ct.trade.side,
        outcome: ct.trade.outcome,
        price: ct.trade.price,
        sizeUsdc: ct.trade.sizeUsdc,
        timestamp: ct.trade.timestamp,
        isMaker: ct.trade.isMaker,
      }))
      .sort((a, b) => b.timestamp - a.timestamp);

    return {
      timestamp: Date.now(),
      topWhales,
      recentTrades: trades,
      activeAccumulations: edgeScan.whaleOpportunities || [],
      stats: {
        totalWhales: stats.whales.total,
        top10Count: stats.whales.top10,
        top50Count: stats.whales.top50,
        cachedTrades: stats.cachedWhaleTrades,
      },
    };
  }

  /**
   * Get recent whale trades
   */
  private getRecentWhaleTrades(limit: number): WhaleTradeResponse[] | { enabled: false; message: string } {
    if (!this.deps.whaleTracker) {
      return { enabled: false, message: 'Whale tracking not configured' };
    }

    const recentTrades = this.deps.whaleTracker.getRecentWhaleTrades(limit);

    return recentTrades
      .map((ct) => ({
        whaleAddress: ct.trade.whale.address,
        whaleName: ct.trade.whale.name,
        whaleTier: ct.trade.whale.tier,
        marketId: ct.trade.marketId,
        marketTitle: ct.trade.marketTitle,
        marketSlug: ct.trade.marketSlug,
        side: ct.trade.side,
        outcome: ct.trade.outcome,
        price: ct.trade.price,
        sizeUsdc: ct.trade.sizeUsdc,
        timestamp: ct.trade.timestamp,
        isMaker: ct.trade.isMaker,
      }))
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Generate RSS feed of whale trades
   */
  private getWhaleTradesFeed(): string {
    if (!this.deps.whaleTracker) {
      return this.generateEmptyFeed('Whale tracking not configured');
    }

    const recentTrades = this.deps.whaleTracker.getRecentWhaleTrades(50);
    const now = new Date().toUTCString();

    // Sort by timestamp descending (most recent first)
    const sortedTrades = [...recentTrades].sort((a, b) => b.trade.timestamp - a.trade.timestamp);

    const items = sortedTrades.map((ct) => {
      const trade = ct.trade;
      const whale = trade.whale;
      const whaleName = whale.name || whale.address.slice(0, 10);
      const tierEmoji = whale.tier === 'top10' ? '🔴' : whale.tier === 'top50' ? '🟡' : '🟢';
      const sideEmoji = trade.side === 'BUY' ? '📈' : '📉';

      const title = `${tierEmoji} ${whaleName} ${trade.side} ${trade.outcome} @ ${(trade.price * 100).toFixed(0)}%`;
      const marketTitle = trade.marketTitle || 'Unknown Market';
      const marketUrl = trade.marketSlug
        ? `https://polymarket.com/event/${trade.marketSlug}`
        : `https://polymarket.com`;

      const sizeStr = trade.sizeUsdc >= 1000
        ? `$${(trade.sizeUsdc / 1000).toFixed(1)}k`
        : `$${trade.sizeUsdc.toFixed(0)}`;

      const description = `
<p><strong>${sideEmoji} ${whaleName}</strong> (${whale.tier}) ${trade.side} ${trade.outcome} for <strong>${sizeStr}</strong> at ${(trade.price * 100).toFixed(0)}%</p>
<p><strong>Market:</strong> <a href="${marketUrl}">${this.escapeXml(marketTitle)}</a></p>
<p><strong>Whale PnL:</strong> $${(whale.pnl7d / 1000).toFixed(0)}k (7d)</p>
      `.trim();

      const pubDate = new Date(trade.timestamp).toUTCString();
      const guid = `${trade.whale.address}-${trade.marketId}-${trade.timestamp}`;

      return `
    <item>
      <title>${this.escapeXml(title)}</title>
      <link>${marketUrl}</link>
      <description><![CDATA[${description}]]></description>
      <pubDate>${pubDate}</pubDate>
      <guid isPermaLink="false">${guid}</guid>
      <category>${whale.tier}</category>
      <category>${trade.side}</category>
      <category>${trade.outcome}</category>
    </item>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Polymarket Whale Trades</title>
    <link>http://localhost:${this.config.port}/</link>
    <description>Real-time feed of trades from top Polymarket traders</description>
    <language>en-us</language>
    <lastBuildDate>${now}</lastBuildDate>
    <atom:link href="http://localhost:${this.config.port}/api/whales/feed" rel="self" type="application/rss+xml"/>
    <ttl>1</ttl>
${items}
  </channel>
</rss>`;
  }

  private generateEmptyFeed(message: string): string {
    const now = new Date().toUTCString();
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Polymarket Whale Trades</title>
    <link>http://localhost:${this.config.port}/</link>
    <description>${message}</description>
    <lastBuildDate>${now}</lastBuildDate>
  </channel>
</rss>`;
  }

  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Get whale positions for a wallet
   */
  private getWhalePositions(wallet: string): WhalePositionResponse[] | { enabled: false; message: string } {
    if (!this.deps.whaleTracker) {
      return { enabled: false, message: 'Whale tracking not configured' };
    }

    // Get all tracked markets
    const trackedMarkets = this.deps.linker.getTrackedMarkets();
    const positions: WhalePositionResponse[] = [];

    for (const [marketId] of trackedMarkets) {
      // Check both YES and NO outcomes
      for (const outcome of ['YES', 'NO'] as const) {
        const pos = this.deps.whaleTracker.getWhalePosition(wallet, marketId, outcome);
        if (pos && pos.netShares !== 0) {
          const reduction = this.deps.whaleTracker.getPositionReduction(wallet, marketId, outcome);
          positions.push({
            wallet: pos.wallet,
            marketId: pos.marketId,
            outcome: pos.outcome,
            netShares: pos.netShares,
            vwapEntry: pos.vwapEntry,
            realizedPnl: pos.realizedPnl,
            peakShares: pos.peakShares,
            reductionFromPeak: reduction,
          });
        }
      }
    }

    return positions;
  }
}

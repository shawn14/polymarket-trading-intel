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
} from './types.js';

export interface APIServerConfig {
  port: number;
  host?: string;
}

export interface APIServerDependencies {
  polymarket: PolymarketClient;
  congress: CongressClient | null;
  weather: WeatherClient;
  fed: FedClient;
  sports: SportsClient;
  detector: SignalDetector;
  linker: TruthMarketLinker;
  alertEngine: AlertEngine;
  watchlist?: WatchlistManager;
}

export class APIServer {
  private config: APIServerConfig;
  private deps: APIServerDependencies;
  private server: ReturnType<typeof createServer> | null = null;
  private startTime: number = Date.now();
  private recentAlerts: AlertSummary[] = [];
  private maxRecentAlerts = 100;

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

    // Track Weather events
    this.deps.weather.on('alert', () => {
      this.lastUpdates.weather = Date.now();
    });

    this.deps.weather.on('error', (error) => {
      this.errors.weather = { message: error.message, time: Date.now() };
    });

    // Track Fed events
    this.deps.fed.on('event', () => {
      this.lastUpdates.fed = Date.now();
    });

    this.deps.fed.on('error', (error) => {
      this.errors.fed = { message: error.message, time: Date.now() };
    });

    // Track Sports events
    this.deps.sports.on('event', () => {
      this.lastUpdates.sports = Date.now();
    });

    this.deps.sports.on('error', (error) => {
      this.errors.sports = { message: error.message, time: Date.now() };
    });

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
      version: '0.1.0',
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
        { path: '/api/watchlist', description: 'Watchlist management (GET, POST)' },
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
}

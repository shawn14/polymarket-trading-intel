/**
 * Polymarket Trading Intelligence System
 *
 * Detects truth-changing events before Polymarket prices adjust.
 */

import 'dotenv/config';

import { PolymarketClient, parseMarket } from './ingestion/polymarket/index.js';
import { CongressClient } from './ingestion/congress/index.js';
import { WeatherClient } from './ingestion/weather/index.js';
import { FedClient } from './ingestion/fed/index.js';
import { SportsClient } from './ingestion/sports/index.js';
import { WhaleTracker } from './ingestion/whales/index.js';
import { SignalDetector, TruthMarketLinker } from './signals/index.js';
import { AlertEngine } from './alerts/index.js';
import { APIServer } from './api/index.js';
import { ExplainMoveEngine, ArbDetector } from './analysis/index.js';
import { WatchlistManager } from './watchlist/index.js';
import type { ChannelConfig } from './alerts/index.js';

async function main() {
  console.log('Polymarket Trading Intel');
  console.log('========================\n');

  // Configure alert channels
  const channels: ChannelConfig[] = [
    { type: 'console', minPriority: 'low', colorize: true },
  ];

  // Add webhook if configured
  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  if (webhookUrl) {
    channels.push({
      type: 'webhook',
      url: webhookUrl,
      minPriority: 'medium',
    });
    console.log('[System] Webhook alerts enabled');
  }

  // Add file logging if configured
  const alertLogPath = process.env.ALERT_LOG_PATH;
  if (alertLogPath) {
    channels.push({
      type: 'file',
      path: alertLogPath,
      format: 'json',
      minPriority: 'low',
    });
    console.log(`[System] Logging alerts to ${alertLogPath}`);
  }

  // Initialize core components
  const client = new PolymarketClient({ autoReconnect: true });
  const detector = new SignalDetector();
  const linker = new TruthMarketLinker();
  const alertEngine = new AlertEngine({
    channels,
    dedupeWindowMs: 60 * 1000,
    rateLimitPerMinute: 60,
  });

  // Attach detector to Polymarket client
  detector.attach(client);

  // Initialize analysis engines
  const explainEngine = new ExplainMoveEngine({
    moveThreshold: 0.03,  // Explain moves of 3%+
    lookbackMs: 5 * 60 * 1000,  // 5 minute lookback
  });

  const arbDetector = new ArbDetector({
    minEdge: 0.02,  // Alert on 2%+ edge
    checkIntervalMs: 30 * 1000,  // Check every 30s
  });

  // Attach analysis engines
  explainEngine.attachPolymarket(client);
  arbDetector.start();

  // Wire up signal recording for explanations
  detector.on('signal', (signal) => {
    explainEngine.recordSignal(signal);
  });

  // Log significant moves and explanations
  explainEngine.on('explanation', (explanation) => {
    const pct = (explanation.move.magnitude * 100).toFixed(1);
    console.log(`\n[ExplainMove] ${explanation.move.direction.toUpperCase()} ${pct}%: ${explanation.question.slice(0, 50)}...`);
    console.log(`  Type: ${explanation.moveType} | Confidence: ${explanation.confidence}`);
    console.log(`  ${explanation.summary}`);
    for (const detail of explanation.details.slice(0, 3)) {
      console.log(`  • ${detail}`);
    }
  });

  // Log arbitrage opportunities
  arbDetector.on('opportunity', (opp) => {
    console.log(`\n[ArbDetector] ${opp.type.toUpperCase()} opportunity (${(opp.expectedEdge * 100).toFixed(1)}% edge)`);
    console.log(`  ${opp.description}`);
    for (const market of opp.markets) {
      console.log(`  • ${market.position}: ${market.question.slice(0, 40)}... @ ${(market.currentPrice * 100).toFixed(0)}%`);
    }
  });

  console.log('[System] Analysis engines enabled (ExplainMove + ArbDetector)');

  // Track data flow
  let bookCount = 0;
  let priceCount = 0;
  let tradeCount = 0;

  // Route signals to alert engine
  detector.on('signal', (signal) => {
    alertEngine.sendSignal(signal);
  });

  // Polymarket event handlers
  client.on('connected', () => {
    console.log('[System] Connected to Polymarket WebSocket\n');
  });

  client.on('book', () => bookCount++);
  client.on('price', () => priceCount++);
  client.on('trade', () => tradeCount++);

  client.on('error', (error) => {
    console.error('[System] WebSocket error:', error.message);
  });

  client.on('disconnected', (code, reason) => {
    console.log(`[System] Disconnected: ${code} ${reason}`);
  });

  // Initialize Congress.gov client if API key is available
  const congressApiKey = process.env.CONGRESS_API_KEY;
  let congressClient: CongressClient | null = null;

  if (congressApiKey) {
    congressClient = new CongressClient({
      apiKey: congressApiKey,
      pollIntervalMs: 5 * 60 * 1000,
    });

    congressClient.on('billChange', (change) => {
      alertEngine.sendCongressChange(change);
      // Record for move explanations
      explainEngine.recordTruthEvent({
        source: 'congress',
        type: change.action.type,
        description: `${change.bill.type} ${change.bill.number}: ${change.action.text.slice(0, 100)}`,
        timestamp: Date.now(),
        confidence: change.significance === 'critical' ? 0.95 : change.significance === 'high' ? 0.8 : 0.6,
      });
    });

    congressClient.on('error', (error) => {
      console.error('[Congress] Error:', error.message);
    });

    congressClient.start();
    console.log('[System] Congress.gov monitoring enabled');
  } else {
    console.log('[System] Congress.gov disabled (set CONGRESS_API_KEY)');
  }

  // Initialize Weather client
  const weatherClient = new WeatherClient({
    pollIntervalMs: 5 * 60 * 1000,
    includeMinor: false,
  });

  weatherClient.on('alert', (event) => {
    alertEngine.sendWeatherEvent(event);
    // Record for move explanations
    explainEngine.recordTruthEvent({
      source: 'weather',
      type: event.event,
      description: event.headline.slice(0, 100),
      timestamp: event.timestamp,
      confidence: event.significance === 'critical' ? 0.95 : event.significance === 'high' ? 0.8 : 0.6,
    });
  });

  weatherClient.on('error', (error) => {
    console.error('[Weather] Error:', error.message);
  });

  weatherClient.start();
  console.log('[System] Weather monitoring enabled');

  // Initialize Fed client
  const fedClient = new FedClient({
    pollIntervalMs: 5 * 60 * 1000,
    fredApiKey: process.env.FRED_API_KEY,
  });

  fedClient.on('event', (event) => {
    alertEngine.sendFedEvent(event);
    // Record for move explanations
    explainEngine.recordTruthEvent({
      source: 'fed',
      type: event.type,
      description: event.title.slice(0, 100),
      timestamp: event.timestamp,
      confidence: event.significance === 'critical' ? 0.95 : event.significance === 'high' ? 0.8 : 0.6,
    });
  });

  fedClient.on('error', (error) => {
    console.error('[Fed] Error:', error.message);
  });

  fedClient.start();
  console.log('[System] Fed/FOMC monitoring enabled');

  // Initialize Sports client
  const sportsClient = new SportsClient({
    leagues: ['NFL', 'NBA', 'MLB'],
    pollIntervalMs: 10 * 60 * 1000, // 10 minutes
  });

  sportsClient.on('event', (event) => {
    alertEngine.sendSportsEvent(event);
    // Record for move explanations
    explainEngine.recordTruthEvent({
      source: 'sports',
      type: event.type,
      description: event.headline,
      timestamp: event.timestamp,
      confidence: event.significance === 'critical' ? 0.95 : event.significance === 'high' ? 0.8 : 0.6,
    });
  });

  sportsClient.on('error', (error) => {
    console.error('[Sports] Error:', error.message);
  });

  sportsClient.start();
  console.log('[System] Sports monitoring enabled');

  // Initialize Whale Tracker
  const whaleTracker = new WhaleTracker({ polymarket: client });

  whaleTracker.on('whaleTrade', (trade) => {
    const tierLabel = trade.whale.tier === 'top10' ? '🔴' : trade.whale.tier === 'top50' ? '🟡' : '🟢';
    const sizeK = (trade.sizeUsdc / 1000).toFixed(1);
    console.log(
      `[Whale] ${tierLabel} ${trade.whale.name || trade.whale.address.slice(0, 10)} ` +
      `${trade.side} ${trade.outcome} $${sizeK}k @ ${(trade.price * 100).toFixed(0)}%`
    );
  });

  whaleTracker.on('error', (error) => {
    console.error('[Whale] Error:', error.message);
  });

  await whaleTracker.start();
  console.log('[System] Whale tracking enabled');

  // Initialize Watchlist Manager
  const watchlistPath = process.env.WATCHLIST_PATH || './watchlist.json';
  const watchlistOnly = process.env.WATCHLIST_ONLY === 'true';
  const watchlistManager = new WatchlistManager(watchlistPath);

  try {
    await watchlistManager.load();
    const watchlist = watchlistManager.getWatchlist();
    console.log(`[System] Watchlist loaded: ${watchlist.markets.length} markets`);
    if (watchlistOnly) {
      console.log('[System] WATCHLIST_ONLY mode: alerts filtered to watched markets only');
    }
  } catch (error) {
    console.log('[System] No watchlist found, starting fresh');
  }

  // Attach watchlist to linker for targeted alerting
  linker.setWatchlistManager(watchlistManager, watchlistOnly);

  // Attach linker to all data sources
  linker.attach({
    polymarket: client,
    congress: congressClient ?? undefined,
    weather: weatherClient,
    fed: fedClient,
    sports: sportsClient,
  });

  // Route linked alerts to alert engine
  linker.on('alert', (alert) => {
    alertEngine.sendLinkedAlert(alert);
  });

  // Alert engine error handling
  alertEngine.on('error', (error, channel) => {
    console.error(`[AlertEngine] Error on ${channel}:`, error.message);
  });

  // Initialize API server
  const apiPort = parseInt(process.env.API_PORT || '3000', 10);
  const apiServer = new APIServer(
    { port: apiPort },
    {
      polymarket: client,
      congress: congressClient,
      weather: weatherClient,
      fed: fedClient,
      sports: sportsClient,
      whaleTracker,
      detector,
      linker,
      alertEngine,
      watchlist: watchlistManager,
    }
  );

  try {
    await apiServer.start();
  } catch (error) {
    console.error('[API] Failed to start:', error);
  }

  // Connect to Polymarket
  await client.connect();

  // Fetch active high-volume markets and subscribe
  console.log('\n[System] Fetching high-volume markets...\n');

  // Configurable market limit via env var (default: all available)
  const marketLimit = parseInt(process.env.MARKET_LIMIT || '500', 10);

  const rawMarkets = await client.fetchMarkets({
    active: true,
    closed: false,
    limit: 500,  // Fetch all available
    order: 'volume',
    ascending: false,
  });

  const assetIds: string[] = [];
  let marketCount = 0;

  for (const rawMarket of rawMarkets) {
    const market = parseMarket(rawMarket);

    if (market.tokenIds.length > 0 && market.question) {
      // Only print first 10 markets to avoid noise
      if (marketCount < 10) {
        const questionPreview = market.question.length > 60
          ? market.question.slice(0, 57) + '...'
          : market.question;
        const priceStr = market.outcomePrices.length > 0
          ? ` (${(market.outcomePrices[0] * 100).toFixed(0)}%)`
          : '';
        console.log(`  ${questionPreview}${priceStr}`);
      } else if (marketCount === 10) {
        console.log(`  ... and ${marketLimit - 10} more markets`);
      }

      // Register with detector and analysis engines
      for (let i = 0; i < market.tokenIds.length; i++) {
        detector.setMarketQuestion(market.tokenIds[i], market.question);
        explainEngine.setMarketQuestion(market.tokenIds[i], market.question);
        arbDetector.updateMarket(
          market.tokenIds[i],
          market.question,
          market.outcomePrices[i] ?? 0.5
        );
      }

      assetIds.push(...market.tokenIds);
      marketCount++;

      if (marketCount >= marketLimit) break;
    }
  }

  if (assetIds.length > 0) {
    console.log(`\n[System] Subscribing to ${assetIds.length} tokens from ${marketCount} markets`);
    console.log('[System] Watching for signals...\n');
    client.subscribe(assetIds);

    // Status update every 30 seconds
    const statusInterval = setInterval(() => {
      const states = detector.getAllMarketStates();
      const rate = alertEngine.getCurrentRate();
      const weatherAlerts = weatherClient.getSeenAlertCount();
      const trackedPlayers = sportsClient.getTrackedPlayerCount();
      console.log(
        `[Status] Books: ${bookCount} | Prices: ${priceCount} | Trades: ${tradeCount} | ` +
        `Markets: ${states.size} | Weather: ${weatherAlerts} | Players: ${trackedPlayers} | Alerts/min: ${rate}`
      );
    }, 30000);

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n[System] Shutting down...');
      clearInterval(statusInterval);
      arbDetector.stop();
      await apiServer.stop();
      linker.stop();
      whaleTracker.stop();
      sportsClient.stop();
      fedClient.stop();
      weatherClient.stop();
      congressClient?.stop();
      client.disconnect();
      process.exit(0);
    });
  } else {
    console.log('[System] No markets with tokens found');
    process.exit(1);
  }
}

main().catch(console.error);

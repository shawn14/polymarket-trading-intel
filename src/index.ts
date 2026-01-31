/**
 * Polymarket Trading Intelligence System
 *
 * Whale-focused trading intelligence for Polymarket.
 */

import 'dotenv/config';

import { PolymarketClient, parseMarket } from './ingestion/polymarket/index.js';
import { WhaleTracker } from './ingestion/whales/index.js';
import { KalshiClient } from './ingestion/kalshi/index.js';
import { SignalDetector, TruthMarketLinker } from './signals/index.js';
import { AlertEngine } from './alerts/index.js';
import { APIServer } from './api/index.js';
import { ExplainMoveEngine, ArbDetector } from './analysis/index.js';
import { WatchlistManager } from './watchlist/index.js';
import { TradeRecorder } from './db/trade-recorder.js';
import { ImpactWorker } from './db/impact-worker.js';
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

  // Initialize Trade Database & Impact Tracking
  const priceProvider = {
    getMarketMid: (marketId: string) => detector.getMarketState(marketId)?.currentPrice,
    getMarketBid: (marketId: string) => detector.getMarketState(marketId)?.bestBid,
    getMarketAsk: (marketId: string) => detector.getMarketState(marketId)?.bestAsk,
    getActiveMarkets: () => [...detector.getAllMarketStates().keys()],
  };

  const tradeRecorder = new TradeRecorder(priceProvider);
  const impactWorker = new ImpactWorker(priceProvider);

  // Record whale trades to database
  whaleTracker.on('whaleTrade', (trade) => {
    tradeRecorder.recordWhaleTrade(trade);
  });

  // Start impact worker
  impactWorker.start();

  impactWorker.on('jobsProcessed', (count) => {
    if (count > 0) {
      console.log(`[ImpactWorker] Processed ${count} impact jobs`);
    }
  });

  impactWorker.on('error', (error) => {
    console.error('[ImpactWorker] Error:', error.message);
  });

  console.log('[System] Trade database & impact tracking enabled');

  // Initialize Kalshi Client for cross-platform intelligence
  const kalshiClient = new KalshiClient({
    pollIntervalMs: 5 * 60 * 1000, // 5 minutes
    autoStart: true,
  });

  kalshiClient.on('update', (markets) => {
    console.log(`[Kalshi] Updated: ${markets.length} markets cached`);
  });

  kalshiClient.on('error', (error) => {
    console.error('[Kalshi] Error:', error.message);
  });

  console.log('[System] Kalshi cross-platform intel enabled');

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

  // Attach linker to Polymarket
  linker.attach({
    polymarket: client,
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
      congress: null,
      weather: null,
      fed: null,
      sports: null,
      whaleTracker,
      kalshi: kalshiClient,
      detector,
      linker,
      alertEngine,
      watchlist: watchlistManager,
      tradeRecorder,
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
      const whaleStats = whaleTracker.getStats();
      console.log(
        `[Status] Books: ${bookCount} | Prices: ${priceCount} | Trades: ${tradeCount} | ` +
        `Markets: ${states.size} | Whales: ${whaleStats.whales.total} | Whale Trades: ${whaleStats.cachedWhaleTrades}`
      );
    }, 30000);

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n[System] Shutting down...');
      clearInterval(statusInterval);
      arbDetector.stop();
      kalshiClient.stop();
      await apiServer.stop();
      linker.stop();
      whaleTracker.stop();
      client.disconnect();
      process.exit(0);
    });
  } else {
    console.log('[System] No markets with tokens found');
    process.exit(1);
  }
}

main().catch(console.error);

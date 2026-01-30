/**
 * Signal Detection Engine
 *
 * Processes real-time market data and detects actionable signals:
 * - Price spikes (rapid price movement)
 * - Volume spikes (unusual trading activity)
 * - Spread compression (informed buyer signal)
 * - Aggressive sweeps (large directional trades)
 * - Depth pulls (liquidity withdrawal)
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { PolymarketClient } from '../ingestion/polymarket/index.js';
import type { OrderBook, PriceUpdate, Trade } from '../ingestion/polymarket/index.js';
import type {
  Signal,
  SignalStrength,
  SignalData,
  MarketState,
  DetectorConfig,
  PriceSpikeData,
  VolumeSpikeData,
  SpreadCompressionData,
  AggressiveSweepData,
  DepthPullData,
} from './types.js';
import { DEFAULT_CONFIG } from './types.js';

export interface SignalDetectorEvents {
  signal: [signal: Signal];
}

// Minimum time before firing signals for a new market (allow baseline to establish)
const WARMUP_MS = 30 * 1000; // 30 seconds

// Cooldown between duplicate signals for the same asset
const SIGNAL_COOLDOWN_MS = 60 * 1000; // 1 minute

export class SignalDetector extends EventEmitter<SignalDetectorEvents> {
  private config: DetectorConfig;
  private marketStates: Map<string, MarketState> = new Map();
  private client: PolymarketClient | null = null;
  private lastSignals: Map<string, number> = new Map(); // assetId:type -> timestamp
  private marketQuestions: Map<string, string> = new Map(); // assetId -> question

  constructor(config: Partial<DetectorConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register a market question for better signal descriptions
   */
  setMarketQuestion(assetId: string, question: string): void {
    this.marketQuestions.set(assetId, question);
  }

  /**
   * Get the human-readable question for an asset
   */
  getMarketQuestion(assetId: string): string | undefined {
    return this.marketQuestions.get(assetId);
  }

  /**
   * Get all registered market questions
   */
  getAllMarketQuestions(): Map<string, string> {
    return new Map(this.marketQuestions);
  }

  /**
   * Attach to a PolymarketClient and start detecting signals
   */
  attach(client: PolymarketClient): void {
    this.client = client;

    client.on('book', (book) => this.handleBook(book));
    client.on('price', (update) => this.handlePriceUpdate(update));
    client.on('trade', (trade) => this.handleTrade(trade));

    console.log('[SignalDetector] Attached to Polymarket client');
  }

  /**
   * Get current state for a market
   */
  getMarketState(assetId: string): MarketState | undefined {
    return this.marketStates.get(assetId);
  }

  /**
   * Get all tracked market states
   */
  getAllMarketStates(): Map<string, MarketState> {
    return new Map(this.marketStates);
  }

  private getOrCreateState(assetId: string, market: string): MarketState {
    let state = this.marketStates.get(assetId);

    if (!state) {
      const now = Date.now();
      state = {
        assetId,
        market,
        priceHistory: [],
        currentPrice: 0,
        volumeHistory: [],
        recentVolume: 0,
        bestBid: 0,
        bestAsk: 1,
        spread: 1,
        bidDepth: 0,
        askDepth: 0,
        recentTrades: [],
        firstSeen: now,
        lastUpdate: now,
      };
      this.marketStates.set(assetId, state);
    }

    return state;
  }

  private handleBook(book: OrderBook): void {
    const state = this.getOrCreateState(book.assetId, book.market);
    const now = Date.now();

    // Calculate total depth
    const newBidDepth = book.bids.reduce((sum, b) => sum + b.size, 0);
    const newAskDepth = book.asks.reduce((sum, a) => sum + a.size, 0);

    // Check for depth pull
    if (state.bidDepth > 0) {
      this.checkDepthPull(state, 'bid', state.bidDepth, newBidDepth);
    }
    if (state.askDepth > 0) {
      this.checkDepthPull(state, 'ask', state.askDepth, newAskDepth);
    }

    // Check for spread compression
    if (state.spread > 0 && state.spread < 1) {
      this.checkSpreadCompression(state, state.spread, book.spread);
    }

    // Update state
    state.bestBid = book.bestBid;
    state.bestAsk = book.bestAsk;
    state.spread = book.spread;
    state.bidDepth = newBidDepth;
    state.askDepth = newAskDepth;
    state.lastUpdate = now;

    // Update price if we have a valid midpoint
    if (book.midpoint > 0 && book.midpoint < 1) {
      this.updatePrice(state, book.midpoint, now);
    }
  }

  private handlePriceUpdate(update: PriceUpdate): void {
    const state = this.getOrCreateState(update.assetId, update.market);
    const now = Date.now();

    // Update order book state
    state.bestBid = update.bestBid;
    state.bestAsk = update.bestAsk;
    state.spread = update.bestAsk - update.bestBid;
    state.lastUpdate = now;

    // Track the price
    const midpoint = (update.bestBid + update.bestAsk) / 2;
    if (midpoint > 0 && midpoint < 1) {
      this.updatePrice(state, midpoint, now);
    }
  }

  private handleTrade(trade: Trade): void {
    const state = this.getOrCreateState(trade.assetId, trade.market);
    const now = Date.now();

    // Add to recent trades
    state.recentTrades.push({
      price: trade.price,
      size: trade.size,
      side: trade.side,
      timestamp: trade.timestamp,
    });

    // Track volume
    state.volumeHistory.push({
      volume: trade.size,
      timestamp: trade.timestamp,
    });
    state.recentVolume += trade.size;

    // Update price
    if (trade.price > 0 && trade.price < 1) {
      this.updatePrice(state, trade.price, now);
    }

    state.lastUpdate = now;

    // Clean old data and check for signals
    this.cleanOldData(state, now);
    this.checkAggressiveSweep(state);
    this.checkVolumeSpike(state);
  }

  private updatePrice(state: MarketState, price: number, timestamp: number): void {
    const previousPrice = state.currentPrice;
    state.currentPrice = price;

    state.priceHistory.push({ price, timestamp });

    // Check for price spike if we have previous data
    if (previousPrice > 0) {
      this.checkPriceSpike(state, previousPrice, price, timestamp);
    }
  }

  private checkPriceSpike(
    state: MarketState,
    previousPrice: number,
    currentPrice: number,
    timestamp: number
  ): void {
    const config = this.config.priceSpike;
    const windowStart = timestamp - config.timeWindowMs;

    // Need at least some price history within the window to detect spikes
    const pricesInWindow = state.priceHistory.filter((p) => p.timestamp > windowStart);
    if (pricesInWindow.length < 2) {
      return; // Not enough data yet
    }

    // Find price from start of window
    const oldPrices = state.priceHistory.filter((p) => p.timestamp <= windowStart);
    if (oldPrices.length === 0) {
      return; // No baseline price from before the window
    }

    const windowStartPrice = oldPrices[oldPrices.length - 1].price;

    // Skip if the baseline price is unrealistic (edge cases)
    if (windowStartPrice <= 0 || windowStartPrice >= 1) {
      return;
    }

    const changePercent = Math.abs((currentPrice - windowStartPrice) / windowStartPrice) * 100;

    if (changePercent >= config.thresholdPercent) {
      const strength = this.calculateStrength(changePercent, config.minStrengthPercent);
      const direction = currentPrice > windowStartPrice ? 'up' : 'down';

      const data: PriceSpikeData = {
        type: 'price_spike',
        previousPrice: windowStartPrice,
        currentPrice,
        changePercent,
        direction,
        timeWindowMs: config.timeWindowMs,
      };

      this.emitSignal(state, 'price_spike', strength, data,
        `Price ${direction} ${changePercent.toFixed(1)}% in ${config.timeWindowMs / 60000}min ` +
        `(${windowStartPrice.toFixed(3)} → ${currentPrice.toFixed(3)})`
      );
    }
  }

  private checkVolumeSpike(state: MarketState): void {
    const config = this.config.volumeSpike;
    const now = Date.now();
    const recentWindowMs = 60 * 1000; // 1 minute of recent volume

    // Calculate recent volume (last minute)
    const recentVolume = state.volumeHistory
      .filter((v) => v.timestamp > now - recentWindowMs)
      .reduce((sum, v) => sum + v.volume, 0);

    // Calculate baseline volume (per minute average over baseline window)
    const baselineStart = now - config.baselineWindowMs;
    const baselineVolumes = state.volumeHistory.filter(
      (v) => v.timestamp > baselineStart && v.timestamp <= now - recentWindowMs
    );

    if (baselineVolumes.length === 0) return;

    const baselineTotal = baselineVolumes.reduce((sum, v) => sum + v.volume, 0);
    const baselineMinutes = (now - recentWindowMs - baselineStart) / 60000;
    const baselinePerMinute = baselineMinutes > 0 ? baselineTotal / baselineMinutes : baselineTotal;

    if (baselinePerMinute === 0) return;

    const multiplier = recentVolume / baselinePerMinute;

    if (multiplier >= config.multiplierThreshold) {
      const strength = this.calculateStrength(multiplier, config.minStrengthMultiplier);

      const data: VolumeSpikeData = {
        type: 'volume_spike',
        currentVolume: recentVolume,
        baselineVolume: baselinePerMinute,
        multiplier,
        timeWindowMs: recentWindowMs,
      };

      this.emitSignal(state, 'volume_spike', strength, data,
        `Volume ${multiplier.toFixed(1)}x baseline (${recentVolume.toFixed(0)} vs ${baselinePerMinute.toFixed(0)}/min)`
      );
    }
  }

  private checkSpreadCompression(
    state: MarketState,
    previousSpread: number,
    currentSpread: number
  ): void {
    const config = this.config.spreadCompression;

    if (previousSpread < config.minSpread) return;

    const compressionPercent = ((previousSpread - currentSpread) / previousSpread) * 100;

    if (compressionPercent >= config.thresholdPercent) {
      // Determine which side compressed
      const side = 'both'; // Could be more sophisticated with bid/ask tracking

      const data: SpreadCompressionData = {
        type: 'spread_compression',
        previousSpread,
        currentSpread,
        compressionPercent,
        side,
      };

      const strength: SignalStrength = compressionPercent >= 70 ? 'high' :
        compressionPercent >= 50 ? 'medium' : 'low';

      this.emitSignal(state, 'spread_compression', strength, data,
        `Spread compressed ${compressionPercent.toFixed(0)}% ` +
        `(${(previousSpread * 100).toFixed(1)}% → ${(currentSpread * 100).toFixed(1)}%)`
      );
    }
  }

  private checkAggressiveSweep(state: MarketState): void {
    const config = this.config.aggressiveSweep;
    const now = Date.now();
    const windowStart = now - config.timeWindowMs;

    // Get recent trades
    const recentTrades = state.recentTrades.filter((t) => t.timestamp > windowStart);

    if (recentTrades.length < config.minTradeCount) return;

    // Check for directional sweeps (mostly same side)
    const buys = recentTrades.filter((t) => t.side === 'BUY');
    const sells = recentTrades.filter((t) => t.side === 'SELL');

    const dominantSide = buys.length > sells.length ? 'BUY' : 'SELL';
    const dominantTrades = dominantSide === 'BUY' ? buys : sells;

    if (dominantTrades.length < config.minTradeCount) return;

    const totalSize = dominantTrades.reduce((sum, t) => sum + t.size, 0);

    if (totalSize < config.minTotalSize) return;

    // Calculate price impact
    const prices = dominantTrades.map((t) => t.price).sort((a, b) => a - b);
    const priceImpact = Math.abs(prices[prices.length - 1] - prices[0]);

    if (priceImpact < config.minPriceImpact) return;

    const data: AggressiveSweepData = {
      type: 'aggressive_sweep',
      side: dominantSide,
      totalSize,
      tradeCount: dominantTrades.length,
      priceImpact,
      timeWindowMs: config.timeWindowMs,
    };

    const strength: SignalStrength = totalSize >= 500 ? 'very_high' :
      totalSize >= 200 ? 'high' : totalSize >= 100 ? 'medium' : 'low';

    this.emitSignal(state, 'aggressive_sweep', strength, data,
      `Aggressive ${dominantSide} sweep: ${dominantTrades.length} trades, ` +
      `${totalSize.toFixed(0)} size, ${(priceImpact * 100).toFixed(1)}% impact`
    );
  }

  private checkDepthPull(
    state: MarketState,
    side: 'bid' | 'ask',
    previousDepth: number,
    currentDepth: number
  ): void {
    const config = this.config.depthPull;

    if (previousDepth < config.minDepth) return;

    const pullPercent = ((previousDepth - currentDepth) / previousDepth) * 100;

    if (pullPercent >= config.thresholdPercent) {
      const data: DepthPullData = {
        type: 'depth_pull',
        side,
        previousDepth,
        currentDepth,
        pullPercent,
      };

      const strength: SignalStrength = pullPercent >= 80 ? 'high' :
        pullPercent >= 60 ? 'medium' : 'low';

      this.emitSignal(state, 'depth_pull', strength, data,
        `${side.toUpperCase()} depth pulled ${pullPercent.toFixed(0)}% ` +
        `(${previousDepth.toFixed(0)} → ${currentDepth.toFixed(0)})`
      );
    }
  }

  private calculateStrength(
    value: number,
    thresholds: Record<SignalStrength, number>
  ): SignalStrength {
    if (value >= thresholds.very_high) return 'very_high';
    if (value >= thresholds.high) return 'high';
    if (value >= thresholds.medium) return 'medium';
    return 'low';
  }

  private emitSignal(
    state: MarketState,
    type: Signal['type'],
    strength: SignalStrength,
    data: SignalData,
    description: string
  ): void {
    const now = Date.now();

    // Skip signals during warmup period
    if (now - state.firstSeen < WARMUP_MS) {
      return;
    }

    // Check cooldown for this asset + signal type combination
    const cooldownKey = `${state.assetId}:${type}`;
    const lastSignalTime = this.lastSignals.get(cooldownKey);

    if (lastSignalTime && now - lastSignalTime < SIGNAL_COOLDOWN_MS) {
      return;
    }

    // Record this signal
    this.lastSignals.set(cooldownKey, now);

    // Use stored question if available, otherwise fall back to condition ID
    const marketQuestion = this.marketQuestions.get(state.assetId) || state.market;

    const signal: Signal = {
      id: randomUUID(),
      type,
      strength,
      assetId: state.assetId,
      market: marketQuestion,
      timestamp: now,
      data,
      description,
    };

    this.emit('signal', signal);
  }

  private cleanOldData(state: MarketState, now: number): void {
    const maxAge = Math.max(
      this.config.priceSpike.timeWindowMs,
      this.config.volumeSpike.baselineWindowMs,
      this.config.aggressiveSweep.timeWindowMs
    ) * 2; // Keep 2x the longest window

    const cutoff = now - maxAge;

    state.priceHistory = state.priceHistory.filter((p) => p.timestamp > cutoff);
    state.volumeHistory = state.volumeHistory.filter((v) => v.timestamp > cutoff);
    state.recentTrades = state.recentTrades.filter((t) => t.timestamp > cutoff);
  }
}

/**
 * Kalshi API Client
 *
 * Fetches market data from Kalshi's public API and provides sorted lists:
 * - Movers: Markets with biggest price changes (24h)
 * - Trending: Markets with highest 24h volume
 * - Newest: Recently created markets
 * - Volume: Markets with highest total volume
 *
 * Uses single-writer pattern: periodic fetch -> cache -> many readers
 */

import { EventEmitter } from 'events';
import type {
  KalshiMarket,
  KalshiMarketsResponse,
  KalshiMarketView,
  KalshiSortType,
} from './types.js';

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_MARKETS_PER_REQUEST = 1000;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface KalshiClientOptions {
  pollIntervalMs?: number;
  autoStart?: boolean;
}

export interface KalshiClientEvents {
  update: [markets: KalshiMarketView[]];
  error: [error: Error];
}

export class KalshiClient extends EventEmitter<KalshiClientEvents> {
  private pollIntervalMs: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private cache: KalshiMarketView[] = [];
  private lastFetch = 0;
  private isFetching = false;

  // Track previous prices for computing price changes
  private previousPrices: Map<string, number> = new Map();

  constructor(options: KalshiClientOptions = {}) {
    super();
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    if (options.autoStart !== false) {
      this.start();
    }
  }

  /**
   * Start polling for market data
   */
  start(): void {
    if (this.pollTimer) return;

    console.log('[Kalshi] Starting market data polling');
    this.fetchMarkets(); // Initial fetch

    this.pollTimer = setInterval(() => {
      this.fetchMarkets();
    }, this.pollIntervalMs);
  }

  /**
   * Stop polling
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Fetch active markets from Kalshi using trades API to find active tickers
   */
  async fetchMarkets(): Promise<void> {
    if (this.isFetching) return;
    this.isFetching = true;

    try {
      // Step 1: Get recent trades to find active market tickers
      const tradesUrl = new URL(`${KALSHI_API_BASE}/markets/trades`);
      tradesUrl.searchParams.set('limit', '1000');

      const tradesResponse = await fetch(tradesUrl.toString(), {
        headers: { 'Accept': 'application/json' },
      });

      if (!tradesResponse.ok) {
        throw new Error(`Kalshi trades API error: ${tradesResponse.status}`);
      }

      const tradesData = (await tradesResponse.json()) as { trades?: Array<{ ticker?: string }> };
      const trades = tradesData.trades || [];

      // Extract unique tickers from recent trades
      const activeTickers = new Set<string>();
      for (const trade of trades) {
        if (trade.ticker) {
          activeTickers.add(trade.ticker);
        }
      }

      console.log(`[Kalshi] Found ${activeTickers.size} active tickers from trades`);

      // Step 2: Fetch market details for active tickers (in batches)
      const tickerArray = Array.from(activeTickers);
      const allMarkets: KalshiMarket[] = [];

      // Fetch in batches of 100 tickers
      for (let i = 0; i < tickerArray.length; i += 100) {
        const batch = tickerArray.slice(i, i + 100);
        const url = new URL(`${KALSHI_API_BASE}/markets`);
        url.searchParams.set('tickers', batch.join(','));

        const response = await fetch(url.toString(), {
          headers: { 'Accept': 'application/json' },
        });

        if (response.ok) {
          const data = (await response.json()) as KalshiMarketsResponse;
          allMarkets.push(...data.markets);
        }
      }

      // Step 3: Also fetch some markets from popular series for better coverage
      const popularSeries = ['KXPGATOUR', 'KXNBAGAME', 'KXNFLGAME', 'KXNCAAMBGAME', 'INXD', 'KXBITCOIN'];
      for (const series of popularSeries) {
        try {
          const url = new URL(`${KALSHI_API_BASE}/markets`);
          url.searchParams.set('series_ticker', series);
          url.searchParams.set('status', 'open');
          url.searchParams.set('limit', '100');

          const response = await fetch(url.toString(), {
            headers: { 'Accept': 'application/json' },
          });

          if (response.ok) {
            const data = (await response.json()) as KalshiMarketsResponse;
            // Add markets we don't already have
            for (const m of data.markets) {
              if (!allMarkets.find(existing => existing.ticker === m.ticker)) {
                allMarkets.push(m);
              }
            }
          }
        } catch (e) {
          // Skip failed series
        }
      }

      // Convert to our view format
      const markets = allMarkets.map((m) => this.convertMarket(m));

      this.cache = markets;
      this.lastFetch = Date.now();

      console.log(`[Kalshi] Cached ${markets.length} active markets`);
      this.emit('update', markets);
    } catch (error) {
      console.error('[Kalshi] Failed to fetch markets:', error);
      this.emit('error', error as Error);
    } finally {
      this.isFetching = false;
    }
  }

  /**
   * Convert Kalshi API market to our view format
   */
  private convertMarket(m: KalshiMarket): KalshiMarketView {
    // Prices come in cents (0-100), normalize to 0-1
    // Use yes_bid as primary, fall back to last_price, then 50
    const yesPrice = (m.yes_bid ?? m.last_price ?? 50) / 100;

    // Use API's previous_yes_bid if available (> 0), otherwise use our tracking
    let prevPrice: number;
    if (m.previous_yes_bid && m.previous_yes_bid > 0) {
      prevPrice = m.previous_yes_bid / 100;
    } else {
      prevPrice = this.previousPrices.get(m.ticker) ?? yesPrice;
    }

    // Calculate price change in percentage points (current - previous)
    const priceChange24h = (yesPrice - prevPrice) * 100;

    // Store current price for next comparison (fallback tracking)
    this.previousPrices.set(m.ticker, yesPrice);

    return {
      ticker: m.ticker,
      eventTicker: m.event_ticker,
      title: m.title,
      subtitle: m.subtitle,
      yesPrice,
      noPrice: 1 - yesPrice,
      lastPrice: (m.last_price ?? 50) / 100,
      priceChange24h,
      volume24h: m.volume_24h ?? 0,
      totalVolume: m.volume ?? 0,
      liquidity: m.liquidity ?? 0,
      openInterest: m.open_interest ?? 0,
      closeTime: m.close_time,
      category: m.category,
      // Kalshi URL: use event ticker base (lowercase, strip date suffix)
      url: `https://kalshi.com/markets/${m.event_ticker.split('-')[0].toLowerCase()}`,
    };
  }

  /**
   * Get markets sorted by type
   */
  getMarkets(sortType: KalshiSortType, limit = 20): KalshiMarketView[] {
    const markets = [...this.cache];

    switch (sortType) {
      case 'movers':
        // Sort by absolute price change (biggest movers first)
        markets.sort((a, b) => Math.abs(b.priceChange24h) - Math.abs(a.priceChange24h));
        break;

      case 'trending':
        // Sort by 24h volume (proxy for trending)
        markets.sort((a, b) => b.volume24h - a.volume24h);
        break;

      case 'newest':
        // Filter to markets with close time, sort by close time ascending (soonest closing = newest)
        // Since we don't have created_time, use markets closing soonest as a proxy for "active/new"
        const withCloseTime = markets.filter((m) => m.closeTime);
        withCloseTime.sort((a, b) => {
          const aTime = new Date(a.closeTime!).getTime();
          const bTime = new Date(b.closeTime!).getTime();
          return aTime - bTime;
        });
        return withCloseTime.slice(0, limit);

      case 'volume':
        // Sort by total volume
        markets.sort((a, b) => b.totalVolume - a.totalVolume);
        break;
    }

    return markets.slice(0, limit);
  }

  /**
   * Get movers (biggest price changes)
   */
  getMovers(limit = 20): KalshiMarketView[] {
    return this.getMarkets('movers', limit);
  }

  /**
   * Get trending (highest 24h volume)
   */
  getTrending(limit = 20): KalshiMarketView[] {
    return this.getMarkets('trending', limit);
  }

  /**
   * Get newest markets
   */
  getNewest(limit = 20): KalshiMarketView[] {
    return this.getMarkets('newest', limit);
  }

  /**
   * Get top volume markets
   */
  getTopVolume(limit = 20): KalshiMarketView[] {
    return this.getMarkets('volume', limit);
  }

  /**
   * Get cache status
   */
  getStats(): { cachedMarkets: number; lastFetch: number; cacheAgeMs: number } {
    return {
      cachedMarkets: this.cache.length,
      lastFetch: this.lastFetch,
      cacheAgeMs: Date.now() - this.lastFetch,
    };
  }

  /**
   * Check if cache is stale
   */
  isCacheStale(): boolean {
    return Date.now() - this.lastFetch > CACHE_TTL_MS;
  }

  /**
   * Force refresh the cache
   */
  async refresh(): Promise<void> {
    await this.fetchMarkets();
  }

  /**
   * Get all cached markets
   */
  getAllMarkets(): KalshiMarketView[] {
    return [...this.cache];
  }
}

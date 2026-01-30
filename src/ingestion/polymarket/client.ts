/**
 * Polymarket WebSocket Client
 *
 * Connects to Polymarket CLOB WebSocket for real-time market data:
 * - Order book snapshots and updates
 * - Price changes
 * - Trade execution
 * - Market resolution
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type {
  MarketChannelMessage,
  BookMessage,
  PriceChangeMessage,
  LastTradePriceMessage,
  OrderBook,
  PriceUpdate,
  Trade,
  Market,
} from './types.js';

const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const GAMMA_API_URL = 'https://gamma-api.polymarket.com';

const RECONNECT_DELAY_MS = 5000;
const PING_INTERVAL_MS = 30000;

export interface PolymarketClientOptions {
  autoReconnect?: boolean;
}

export interface PolymarketClientEvents {
  connected: [];
  disconnected: [code: number, reason: string];
  error: [error: Error];
  book: [book: OrderBook];
  price: [update: PriceUpdate];
  trade: [trade: Trade];
  marketResolved: [market: string, assetId: string, winner: boolean];
}

export class PolymarketClient extends EventEmitter<PolymarketClientEvents> {
  private ws: WebSocket | null = null;
  private subscribedAssets: Set<string> = new Set();
  private orderBooks: Map<string, OrderBook> = new Map();
  private autoReconnect: boolean;
  private pingInterval: NodeJS.Timeout | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private isConnecting = false;

  constructor(options: PolymarketClientOptions = {}) {
    super();
    this.autoReconnect = options.autoReconnect ?? true;
  }

  /**
   * Connect to the Polymarket WebSocket
   */
  connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    if (this.isConnecting) {
      return Promise.resolve();
    }

    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(CLOB_WS_URL);

      this.ws.on('open', () => {
        this.isConnecting = false;
        console.log('[Polymarket] Connected to WebSocket');
        this.startPing();
        this.resubscribe();
        this.emit('connected');
        resolve();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('error', (error) => {
        this.isConnecting = false;
        console.error('[Polymarket] WebSocket error:', error.message);
        this.emit('error', error);
        reject(error);
      });

      this.ws.on('close', (code, reason) => {
        this.isConnecting = false;
        this.stopPing();
        console.log(`[Polymarket] Disconnected: ${code} ${reason.toString()}`);
        this.emit('disconnected', code, reason.toString());

        if (this.autoReconnect) {
          this.scheduleReconnect();
        }
      });
    });
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    this.autoReconnect = false;
    this.clearReconnectTimeout();
    this.stopPing();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Subscribe to market updates by asset IDs (token IDs)
   */
  subscribe(assetIds: string[]): void {
    for (const id of assetIds) {
      this.subscribedAssets.add(id);
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscription(assetIds);
    }
  }

  /**
   * Unsubscribe from market updates
   */
  unsubscribe(assetIds: string[]): void {
    for (const id of assetIds) {
      this.subscribedAssets.delete(id);
      this.orderBooks.delete(id);
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      const message = JSON.stringify({
        type: 'MARKET',
        operation: 'unsubscribe',
        assets_ids: assetIds,
      });
      this.ws.send(message);
    }
  }

  /**
   * Get current order book for an asset
   */
  getOrderBook(assetId: string): OrderBook | undefined {
    return this.orderBooks.get(assetId);
  }

  /**
   * Get all tracked order books
   */
  getAllOrderBooks(): Map<string, OrderBook> {
    return new Map(this.orderBooks);
  }

  /**
   * Fetch markets from REST API
   */
  async fetchMarkets(params?: {
    active?: boolean;
    closed?: boolean;
    limit?: number;
    offset?: number;
    order?: 'volume' | 'liquidity' | 'createdAt' | 'endDate';
    ascending?: boolean;
  }): Promise<Market[]> {
    const url = new URL(`${GAMMA_API_URL}/markets`);

    if (params?.active !== undefined) {
      url.searchParams.set('active', String(params.active));
    }
    if (params?.closed !== undefined) {
      url.searchParams.set('closed', String(params.closed));
    }
    if (params?.limit !== undefined) {
      url.searchParams.set('limit', String(params.limit));
    }
    if (params?.offset !== undefined) {
      url.searchParams.set('offset', String(params.offset));
    }
    if (params?.order !== undefined) {
      url.searchParams.set('order', params.order);
    }
    if (params?.ascending !== undefined) {
      url.searchParams.set('ascending', String(params.ascending));
    }

    const response = await fetch(url.toString());

    if (!response.ok) {
      throw new Error(`Failed to fetch markets: ${response.status}`);
    }

    return response.json() as Promise<Market[]>;
  }

  /**
   * Fetch a single market by slug
   */
  async fetchMarketBySlug(slug: string): Promise<Market | null> {
    const response = await fetch(`${GAMMA_API_URL}/markets?slug=${encodeURIComponent(slug)}`);

    if (!response.ok) {
      throw new Error(`Failed to fetch market: ${response.status}`);
    }

    const markets = (await response.json()) as Market[];
    return markets[0] ?? null;
  }

  /**
   * Search markets by query
   */
  async searchMarkets(query: string, limit = 10): Promise<Market[]> {
    const response = await fetch(
      `${GAMMA_API_URL}/markets?_q=${encodeURIComponent(query)}&limit=${limit}`
    );

    if (!response.ok) {
      throw new Error(`Failed to search markets: ${response.status}`);
    }

    return response.json() as Promise<Market[]>;
  }

  private sendSubscription(assetIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const message = JSON.stringify({
      type: 'MARKET',
      assets_ids: assetIds,
    });
    this.ws.send(message);
  }

  private resubscribe(): void {
    if (this.subscribedAssets.size > 0) {
      this.sendSubscription([...this.subscribedAssets]);
    }
  }

  private handleMessage(data: string): void {
    try {
      const messages = JSON.parse(data) as MarketChannelMessage | MarketChannelMessage[];
      const messageArray = Array.isArray(messages) ? messages : [messages];

      for (const message of messageArray) {
        this.processMessage(message);
      }
    } catch (error) {
      console.error('[Polymarket] Failed to parse message:', error);
    }
  }

  private processMessage(message: MarketChannelMessage): void {
    // Handle messages that might not have event_type (connection acks, etc.)
    if (!message || typeof message !== 'object') return;
    if (!('event_type' in message)) return;

    switch (message.event_type) {
      case 'book':
        this.handleBookMessage(message);
        break;
      case 'price_change':
        this.handlePriceChange(message);
        break;
      case 'last_trade_price':
        this.handleLastTradePrice(message);
        break;
      case 'market_resolved':
        this.emit('marketResolved', message.market, message.asset_id, message.winner);
        break;
      // Ignore other message types (tick_size_change, best_bid_ask, new_market, etc.)
    }
  }

  private handleBookMessage(message: BookMessage): void {
    const bids = (message.buys ?? []).map((o) => ({
      price: parseFloat(o.price),
      size: parseFloat(o.size),
    }));
    const asks = (message.sells ?? []).map((o) => ({
      price: parseFloat(o.price),
      size: parseFloat(o.size),
    }));

    const bestBid = bids.length > 0 ? Math.max(...bids.map((b) => b.price)) : 0;
    const bestAsk = asks.length > 0 ? Math.min(...asks.map((a) => a.price)) : 1;
    const spread = bestAsk - bestBid;
    const midpoint = (bestBid + bestAsk) / 2;

    const orderBook: OrderBook = {
      assetId: message.asset_id,
      market: message.market,
      timestamp: message.timestamp,
      bids,
      asks,
      bestBid,
      bestAsk,
      spread,
      midpoint,
    };

    this.orderBooks.set(message.asset_id, orderBook);
    this.emit('book', orderBook);
  }

  private handlePriceChange(message: PriceChangeMessage): void {
    for (const change of message.price_changes) {
      const update: PriceUpdate = {
        assetId: change.asset_id,
        market: message.market,
        price: parseFloat(change.price),
        side: change.side,
        size: parseFloat(change.size),
        bestBid: parseFloat(change.best_bid),
        bestAsk: parseFloat(change.best_ask),
        timestamp: message.timestamp,
      };

      // Update cached order book with new best bid/ask
      const book = this.orderBooks.get(change.asset_id);
      if (book) {
        book.bestBid = update.bestBid;
        book.bestAsk = update.bestAsk;
        book.spread = update.bestAsk - update.bestBid;
        book.midpoint = (update.bestBid + update.bestAsk) / 2;
        book.timestamp = message.timestamp;
      }

      this.emit('price', update);
    }
  }

  private handleLastTradePrice(message: LastTradePriceMessage): void {
    const trade: Trade = {
      assetId: message.asset_id,
      market: message.market,
      price: parseFloat(message.price),
      side: message.side,
      size: parseFloat(message.size),
      timestamp: message.timestamp,
    };

    this.emit('trade', trade);
  }

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimeout();

    console.log(`[Polymarket] Reconnecting in ${RECONNECT_DELAY_MS}ms...`);

    this.reconnectTimeout = setTimeout(() => {
      this.connect().catch((error) => {
        console.error('[Polymarket] Reconnect failed:', error);
      });
    }, RECONNECT_DELAY_MS);
  }

  private clearReconnectTimeout(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }
}

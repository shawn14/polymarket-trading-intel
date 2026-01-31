/**
 * Whale Activity Monitor
 *
 * Polls Polymarket's activity API to detect whale trades in real-time.
 * This is the bridge between the leaderboard whales and actual trade detection.
 */

import { EventEmitter } from 'events';
import type { WhaleInfo, WhaleTrade, StoredTrade } from './types.js';
import type { WhaleUniverse } from './whale-universe.js';

// Polymarket activity API
const ACTIVITY_API = 'https://data-api.polymarket.com/activity';

// Poll interval (30 seconds - fast enough to catch moves, slow enough to not hammer API)
const POLL_INTERVAL_MS = 30 * 1000;

// How many whales to poll per cycle (to avoid rate limiting)
const WHALES_PER_CYCLE = 10;

// How far back to look for new trades (5 minutes)
const LOOKBACK_MS = 5 * 60 * 1000;

// Activity API response type
interface ActivityEntry {
  proxyWallet: string;
  timestamp: number;
  conditionId: string;
  type: 'TRADE' | 'REDEEM' | 'MERGE' | 'SPLIT';
  size: number;
  usdcSize: number;
  transactionHash: string;
  price: number;
  asset: string;
  side: 'BUY' | 'SELL' | '';
  outcomeIndex: number;
  title: string;
  slug: string;
  outcome: string;
  name: string;
  pseudonym: string;
}

export interface WhaleActivityEvents {
  whaleTrade: [trade: WhaleTrade, activity: ActivityEntry];
  error: [error: Error];
}

export class WhaleActivityMonitor extends EventEmitter<WhaleActivityEvents> {
  private whaleUniverse: WhaleUniverse;
  private pollTimer: NodeJS.Timeout | null = null;
  private seenTxHashes: Set<string> = new Set();
  private whaleIndex = 0;
  private isRunning = false;

  // Stats
  private pollCount = 0;
  private tradesDetected = 0;

  constructor(whaleUniverse: WhaleUniverse) {
    super();
    this.whaleUniverse = whaleUniverse;
  }

  /**
   * Start monitoring whale activity
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log('[WhaleActivity] Starting whale activity monitor...');

    // Initial poll
    this.pollCycle();

    // Start polling timer
    this.pollTimer = setInterval(() => {
      this.pollCycle();
    }, POLL_INTERVAL_MS);

    console.log(`[WhaleActivity] Polling ${WHALES_PER_CYCLE} whales every ${POLL_INTERVAL_MS / 1000}s`);
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isRunning = false;
    console.log('[WhaleActivity] Stopped');
  }

  /**
   * Poll a batch of whales for activity
   */
  private async pollCycle(): Promise<void> {
    const whales = this.whaleUniverse.getAllWhales();
    if (whales.length === 0) {
      return;
    }

    // Get next batch of whales to poll
    const batch: WhaleInfo[] = [];
    for (let i = 0; i < WHALES_PER_CYCLE && i < whales.length; i++) {
      const idx = (this.whaleIndex + i) % whales.length;
      batch.push(whales[idx]);
    }
    this.whaleIndex = (this.whaleIndex + WHALES_PER_CYCLE) % whales.length;

    // Poll each whale in parallel
    const promises = batch.map(whale => this.pollWhale(whale));
    await Promise.allSettled(promises);

    this.pollCount++;
  }

  /**
   * Poll a single whale for recent activity
   */
  private async pollWhale(whale: WhaleInfo): Promise<void> {
    try {
      const url = `${ACTIVITY_API}?user=${whale.address}&limit=10`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const activities = (await response.json()) as ActivityEntry[];

      // Filter to recent trades only
      const cutoff = Date.now() - LOOKBACK_MS;
      const recentTrades = activities.filter(a =>
        a.type === 'TRADE' &&
        a.timestamp * 1000 > cutoff && // API returns seconds
        !this.seenTxHashes.has(a.transactionHash)
      );

      // Process new trades
      for (const activity of recentTrades) {
        this.seenTxHashes.add(activity.transactionHash);
        this.processActivity(whale, activity);
      }

      // Cleanup old tx hashes (keep last 1000)
      if (this.seenTxHashes.size > 1000) {
        const arr = [...this.seenTxHashes];
        this.seenTxHashes = new Set(arr.slice(-500));
      }

    } catch (error) {
      // Don't spam errors, just log occasionally
      if (this.pollCount % 10 === 0) {
        console.error(`[WhaleActivity] Error polling ${whale.name || whale.address.slice(0, 10)}:`, (error as Error).message);
      }
    }
  }

  /**
   * Process a detected whale trade
   */
  private processActivity(whale: WhaleInfo, activity: ActivityEntry): void {
    this.tradesDetected++;

    // Log the trade
    const sizeStr = activity.usdcSize >= 1000
      ? `$${(activity.usdcSize / 1000).toFixed(1)}k`
      : `$${activity.usdcSize.toFixed(0)}`;
    const priceStr = `${(activity.price * 100).toFixed(0)}%`;

    console.log(
      `[WhaleActivity] ${whale.tier === 'top10' ? '🔴' : '🟡'} ${whale.name || whale.address.slice(0, 10)} ` +
      `${activity.side} ${activity.outcome} ${sizeStr} @ ${priceStr} - ${activity.title.slice(0, 40)}...`
    );

    // Convert to WhaleTrade format
    // Keep original outcome (team name like "Pistons" or "Warriors", or "Yes"/"No")
    // Don't convert to YES/NO - preserve for accurate display
    const whaleTrade: WhaleTrade = {
      whale,
      marketId: activity.conditionId,
      assetId: activity.asset,
      side: activity.side as 'BUY' | 'SELL',
      outcome: activity.outcome as 'YES' | 'NO', // Cast but preserve original value
      price: activity.price,
      size: activity.size,
      sizeUsdc: activity.usdcSize,
      timestamp: activity.timestamp * 1000,
      isMaker: false, // Can't tell from activity API
      marketTitle: activity.title,
      marketSlug: activity.slug,
      outcomeLabel: activity.outcome, // Preserve original for display
    };

    // Emit the trade event
    this.emit('whaleTrade', whaleTrade, activity);
  }

  /**
   * Get monitoring stats
   */
  getStats() {
    return {
      isRunning: this.isRunning,
      pollCount: this.pollCount,
      tradesDetected: this.tradesDetected,
      seenTxHashes: this.seenTxHashes.size,
    };
  }
}

/**
 * Congress.gov API Client
 *
 * Monitors legislative activity for bill status changes.
 * Key use case: Tracking appropriations bills and continuing resolutions
 * for government shutdown market intelligence.
 */

import { EventEmitter } from 'events';
import type {
  BillType,
  BillSummary,
  Bill,
  BillAction,
  BillListResponse,
  BillDetailResponse,
  BillActionsResponse,
  BillStatusChange,
} from './types.js';
import {
  APPROPRIATIONS_KEYWORDS,
  ACTION_SIGNIFICANCE,
  HIGH_SIGNAL_PATTERNS,
} from './types.js';

const API_BASE = 'https://api.congress.gov/v3';
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface CongressClientOptions {
  apiKey: string;
  pollIntervalMs?: number;
}

export interface CongressClientEvents {
  billChange: [change: BillStatusChange];
  error: [error: Error];
}

interface TrackedBill {
  summary: BillSummary;
  lastActionDate: string;
  lastActionText: string;
}

export class CongressClient extends EventEmitter<CongressClientEvents> {
  private apiKey: string;
  private pollIntervalMs: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private trackedBills: Map<string, TrackedBill> = new Map();
  private watchedKeywords: string[] = [...APPROPRIATIONS_KEYWORDS];
  private currentCongress: number;

  constructor(options: CongressClientOptions) {
    super();
    this.apiKey = options.apiKey;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    // Calculate current Congress number (new Congress every 2 years starting 1789)
    const currentYear = new Date().getFullYear();
    this.currentCongress = Math.floor((currentYear - 1789) / 2) + 1;
  }

  /**
   * Start monitoring for bill changes
   */
  start(): void {
    if (this.pollTimer) return;

    console.log(`[Congress] Starting monitor (Congress ${this.currentCongress})`);
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Add keywords to watch for in bill titles
   */
  addWatchKeywords(keywords: string[]): void {
    this.watchedKeywords.push(...keywords);
  }

  /**
   * Get current Congress number
   */
  getCongress(): number {
    return this.currentCongress;
  }

  /**
   * Fetch recent bills from the current Congress
   */
  async fetchRecentBills(limit = 50): Promise<BillSummary[]> {
    const url = `${API_BASE}/bill/${this.currentCongress}?api_key=${this.apiKey}&limit=${limit}&sort=updateDate+desc&format=json`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Congress API error: ${response.status}`);
    }

    const data = (await response.json()) as BillListResponse;
    return data.bills;
  }

  /**
   * Fetch bills by type (hr, s, hjres, etc.)
   */
  async fetchBillsByType(type: BillType, limit = 50): Promise<BillSummary[]> {
    const url = `${API_BASE}/bill/${this.currentCongress}/${type}?api_key=${this.apiKey}&limit=${limit}&sort=updateDate+desc&format=json`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Congress API error: ${response.status}`);
    }

    const data = (await response.json()) as BillListResponse;
    return data.bills;
  }

  /**
   * Fetch detailed bill information
   */
  async fetchBill(type: BillType, number: string): Promise<Bill> {
    const url = `${API_BASE}/bill/${this.currentCongress}/${type}/${number}?api_key=${this.apiKey}&format=json`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Congress API error: ${response.status}`);
    }

    const data = (await response.json()) as BillDetailResponse;
    return data.bill;
  }

  /**
   * Fetch bill actions
   */
  async fetchBillActions(type: BillType, number: string, limit = 50): Promise<BillAction[]> {
    const url = `${API_BASE}/bill/${this.currentCongress}/${type}/${number}/actions?api_key=${this.apiKey}&limit=${limit}&format=json`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Congress API error: ${response.status}`);
    }

    const data = (await response.json()) as BillActionsResponse;
    return data.actions;
  }

  /**
   * Search bills by keyword
   */
  async searchBills(keyword: string, limit = 20): Promise<BillSummary[]> {
    // Congress.gov API doesn't have direct search, so we filter locally
    const allBills = await this.fetchRecentBills(250);

    const keywordLower = keyword.toLowerCase();
    return allBills
      .filter((bill) => bill.title.toLowerCase().includes(keywordLower))
      .slice(0, limit);
  }

  /**
   * Find appropriations and CR bills
   */
  async findAppropriationsBills(): Promise<BillSummary[]> {
    const allBills = await this.fetchRecentBills(250);

    return allBills.filter((bill) => {
      const titleLower = bill.title.toLowerCase();
      return APPROPRIATIONS_KEYWORDS.some((kw) => titleLower.includes(kw.toLowerCase()));
    });
  }

  /**
   * Get tracked bills
   */
  getTrackedBills(): Map<string, TrackedBill> {
    return new Map(this.trackedBills);
  }

  private async poll(): Promise<void> {
    try {
      // Fetch recent bills
      const bills = await this.fetchRecentBills(100);

      // Filter for watched keywords
      const relevantBills = bills.filter((bill) => {
        const titleLower = bill.title.toLowerCase();
        return this.watchedKeywords.some((kw) => titleLower.includes(kw.toLowerCase()));
      });

      // Check for changes
      for (const bill of relevantBills) {
        const billKey = this.getBillKey(bill);
        const tracked = this.trackedBills.get(billKey);

        if (!tracked) {
          // New bill we haven't seen before
          this.trackedBills.set(billKey, {
            summary: bill,
            lastActionDate: bill.latestAction.actionDate,
            lastActionText: bill.latestAction.text,
          });

          // Fetch full actions to emit initial event
          await this.emitBillChange(bill, true);
        } else if (
          bill.latestAction.actionDate !== tracked.lastActionDate ||
          bill.latestAction.text !== tracked.lastActionText
        ) {
          // Bill has been updated
          tracked.summary = bill;
          tracked.lastActionDate = bill.latestAction.actionDate;
          tracked.lastActionText = bill.latestAction.text;

          await this.emitBillChange(bill, false);
        }
      }
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async emitBillChange(bill: BillSummary, isNew: boolean): Promise<void> {
    try {
      // Fetch the latest action details
      const billType = bill.type.toLowerCase() as BillType;
      const actions = await this.fetchBillActions(billType, bill.number, 5);

      if (actions.length === 0) return;

      const latestAction = actions[0];
      const previousAction = actions.length > 1 ? actions[1] : undefined;

      // Determine significance
      let significance = ACTION_SIGNIFICANCE[latestAction.type] ?? 'low';

      // Upgrade significance if action text matches high-signal patterns
      if (HIGH_SIGNAL_PATTERNS.some((pattern) => pattern.test(latestAction.text))) {
        significance = significance === 'low' ? 'medium' : significance === 'medium' ? 'high' : significance;
      }

      const change: BillStatusChange = {
        bill,
        action: latestAction,
        previousAction,
        isNew,
        significance,
      };

      this.emit('billChange', change);
    } catch (error) {
      // Log but don't fail the whole poll
      console.error(`[Congress] Failed to fetch actions for ${bill.number}:`, error);
    }
  }

  private getBillKey(bill: BillSummary): string {
    return `${bill.congress}-${bill.type}-${bill.number}`;
  }
}

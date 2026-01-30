/**
 * Federal Reserve Client
 *
 * Monitors Fed press releases and FOMC statements via RSS.
 * Key use case: Rate decision markets.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type {
  FedEvent,
  FedEventType,
  FedClientConfig,
  RateDecision,
} from './types.js';
import {
  FED_RSS_FEEDS,
  RATE_DECISION_KEYWORDS,
  SENTIMENT_KEYWORDS,
} from './types.js';

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface FedClientEvents {
  event: [event: FedEvent];
  error: [error: Error];
}

export class FedClient extends EventEmitter<FedClientEvents> {
  private config: FedClientConfig;
  private pollTimer: NodeJS.Timeout | null = null;
  private seenGuids: Set<string> = new Set();
  private lastPollTime = 0;

  constructor(config: FedClientConfig = {}) {
    super();
    this.config = {
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      ...config,
    };
  }

  /**
   * Start monitoring Fed releases
   */
  start(): void {
    if (this.pollTimer) return;

    console.log('[Fed] Starting monitor');
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), this.config.pollIntervalMs);
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
   * Fetch and parse the monetary policy RSS feed
   */
  async fetchMonetaryReleases(): Promise<FedEvent[]> {
    const response = await fetch(FED_RSS_FEEDS.monetary);

    if (!response.ok) {
      throw new Error(`Fed RSS error: ${response.status}`);
    }

    const xml = await response.text();
    return this.parseRSS(xml);
  }

  /**
   * Get seen event count
   */
  getSeenEventCount(): number {
    return this.seenGuids.size;
  }

  /**
   * Check if today is an FOMC meeting day
   */
  isFOMCDay(): boolean {
    const today = new Date().toISOString().split('T')[0];
    // Check against known FOMC meeting dates
    const fomcDates = [
      // 2025
      '2025-01-28', '2025-01-29',
      '2025-03-18', '2025-03-19',
      '2025-05-06', '2025-05-07',
      '2025-06-17', '2025-06-18',
      '2025-07-29', '2025-07-30',
      '2025-09-16', '2025-09-17',
      '2025-11-05', '2025-11-06',
      '2025-12-16', '2025-12-17',
      // 2026
      '2026-01-27', '2026-01-28',
      '2026-03-17', '2026-03-18',
      '2026-04-28', '2026-04-29',
      '2026-06-16', '2026-06-17',
      '2026-07-28', '2026-07-29',
      '2026-09-15', '2026-09-16',
      '2026-11-03', '2026-11-04',
      '2026-12-15', '2026-12-16',
    ];
    return fomcDates.includes(today);
  }

  private async poll(): Promise<void> {
    try {
      const events = await this.fetchMonetaryReleases();
      let newCount = 0;

      for (const event of events) {
        // Skip if already seen
        if (this.seenGuids.has(event.id)) continue;

        // Mark as seen
        this.seenGuids.add(event.id);

        // Only emit if it's significant
        if (event.significance !== 'low') {
          this.emit('event', event);
          newCount++;
        }
      }

      this.lastPollTime = Date.now();

      // Clean up old GUIDs
      if (this.seenGuids.size > 500) {
        const arr = [...this.seenGuids];
        this.seenGuids = new Set(arr.slice(-250));
      }

      if (newCount > 0) {
        console.log(`[Fed] ${newCount} new events`);
      }
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }

  private parseRSS(xml: string): FedEvent[] {
    const events: FedEvent[] = [];

    // Simple XML parsing for RSS items
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;

    while ((match = itemRegex.exec(xml)) !== null) {
      const itemXml = match[1];

      const title = this.extractTag(itemXml, 'title');
      const link = this.extractTag(itemXml, 'link');
      const guid = this.extractTag(itemXml, 'guid') || link;
      const pubDate = this.extractTag(itemXml, 'pubDate');
      const description = this.extractTag(itemXml, 'description');

      if (!title || !link) continue;

      const event = this.parseEvent(title, description || '', link, guid || '', pubDate || '');
      if (event) {
        events.push(event);
      }
    }

    return events;
  }

  private extractTag(xml: string, tag: string): string | null {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
    const match = xml.match(regex);
    if (!match) return null;

    // Clean up CDATA and HTML entities
    return match[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/<[^>]+>/g, '') // Strip HTML tags
      .trim();
  }

  private parseEvent(
    title: string,
    description: string,
    url: string,
    guid: string,
    pubDate: string
  ): FedEvent | null {
    const titleLower = title.toLowerCase();
    const descLower = description.toLowerCase();
    const fullText = `${titleLower} ${descLower}`;

    // Determine event type
    let type: FedEventType = 'speech';
    let significance: FedEvent['significance'] = 'low';

    if (titleLower.includes('fomc statement') || titleLower.includes('federal reserve issues fomc')) {
      type = 'fomc_statement';
      significance = 'critical';
    } else if (titleLower.includes('minutes of the federal open market')) {
      type = 'fomc_minutes';
      significance = 'high';
    } else if (titleLower.includes('summary of economic projections')) {
      type = 'economic_projections';
      significance = 'high';
    } else if (titleLower.includes('beige book')) {
      type = 'beige_book';
      significance = 'medium';
    } else if (titleLower.includes('testimony')) {
      type = 'testimony';
      significance = 'medium';
    } else if (
      fullText.includes('target range') ||
      fullText.includes('federal funds rate') ||
      fullText.includes('basis points')
    ) {
      type = 'rate_decision';
      significance = 'critical';
    }

    // Detect rate decision
    let rateDecision: RateDecision | undefined;
    let rateChange: number | undefined;

    if (type === 'fomc_statement' || type === 'rate_decision') {
      // Check for rate hike
      if (RATE_DECISION_KEYWORDS.hike.some((kw) => fullText.includes(kw))) {
        rateDecision = 'hike';
      }
      // Check for rate cut
      else if (RATE_DECISION_KEYWORDS.cut.some((kw) => fullText.includes(kw))) {
        rateDecision = 'cut';
      }
      // Check for hold
      else if (RATE_DECISION_KEYWORDS.hold.some((kw) => fullText.includes(kw))) {
        rateDecision = 'hold';
      }

      // Try to extract basis points
      const bpMatch = fullText.match(/(\d+)\s*basis\s*points?/i);
      if (bpMatch) {
        rateChange = parseInt(bpMatch[1], 10);
        if (rateDecision === 'cut') {
          rateChange = -rateChange;
        }
      }
    }

    // Detect sentiment
    let sentiment: FedEvent['sentiment'];
    const hawkishCount = SENTIMENT_KEYWORDS.hawkish.filter((kw) => fullText.includes(kw)).length;
    const dovishCount = SENTIMENT_KEYWORDS.dovish.filter((kw) => fullText.includes(kw)).length;

    if (hawkishCount > dovishCount + 1) {
      sentiment = 'hawkish';
    } else if (dovishCount > hawkishCount + 1) {
      sentiment = 'dovish';
    } else {
      sentiment = 'neutral';
    }

    // Parse timestamp
    let timestamp = Date.now();
    if (pubDate) {
      const parsed = Date.parse(pubDate);
      if (!isNaN(parsed)) {
        timestamp = parsed;
      }
    }

    return {
      id: guid || randomUUID(),
      type,
      timestamp,
      title,
      description,
      url,
      rateDecision,
      rateChange,
      sentiment,
      significance,
    };
  }
}

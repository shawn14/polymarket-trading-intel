/**
 * Weather Client
 *
 * Monitors NWS alerts and NHC tropical cyclone data.
 * Key use case: Hurricane and severe weather markets.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type {
  NWSAlert,
  NWSAlertsResponse,
  WeatherEvent,
  WeatherClientConfig,
  AlertSeverity,
} from './types.js';
import { HIGH_IMPACT_EVENTS, HURRICANE_STATES } from './types.js';

const NWS_API_BASE = 'https://api.weather.gov';
const NHC_RSS_ATLANTIC = 'https://www.nhc.noaa.gov/index-at.xml';
const NHC_RSS_PACIFIC = 'https://www.nhc.noaa.gov/index-ep.xml';

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const USER_AGENT = 'PolymarketTradingIntel/1.0 (github.com/polymarket-trading-intel)';

export interface WeatherClientEvents {
  alert: [event: WeatherEvent];
  error: [error: Error];
}

export class WeatherClient extends EventEmitter<WeatherClientEvents> {
  private config: WeatherClientConfig;
  private pollTimer: NodeJS.Timeout | null = null;
  private seenAlerts: Set<string> = new Set();
  private lastPollTime = 0;

  constructor(config: WeatherClientConfig = {}) {
    super();
    this.config = {
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      states: HURRICANE_STATES, // Default to hurricane-prone states
      includeMinor: false,
      ...config,
    };
  }

  /**
   * Start monitoring weather alerts
   */
  start(): void {
    if (this.pollTimer) return;

    console.log(`[Weather] Starting monitor (${this.config.states?.length ?? 'all'} states)`);
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
   * Fetch current active alerts
   */
  async fetchActiveAlerts(state?: string): Promise<NWSAlert[]> {
    const url = state
      ? `${NWS_API_BASE}/alerts/active?area=${state}`
      : `${NWS_API_BASE}/alerts/active`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/geo+json',
      },
    });

    if (!response.ok) {
      throw new Error(`NWS API error: ${response.status}`);
    }

    const data = (await response.json()) as NWSAlertsResponse;
    return data.features.map((f) => f.properties);
  }

  /**
   * Fetch alerts for multiple states
   */
  async fetchAlertsForStates(states: string[]): Promise<NWSAlert[]> {
    const allAlerts: NWSAlert[] = [];
    const seen = new Set<string>();

    // Fetch in batches to avoid rate limiting
    for (const state of states) {
      try {
        const alerts = await this.fetchActiveAlerts(state);
        for (const alert of alerts) {
          if (!seen.has(alert.id)) {
            seen.add(alert.id);
            allAlerts.push(alert);
          }
        }
        // Small delay between requests
        await this.delay(100);
      } catch (error) {
        console.error(`[Weather] Error fetching ${state}:`, error);
      }
    }

    return allAlerts;
  }

  /**
   * Get current high-impact alerts
   */
  async getHighImpactAlerts(): Promise<WeatherEvent[]> {
    const states = this.config.states ?? [];
    const alerts = states.length > 0
      ? await this.fetchAlertsForStates(states)
      : await this.fetchActiveAlerts();

    return alerts
      .filter((alert) => this.isHighImpact(alert))
      .map((alert) => this.alertToEvent(alert));
  }

  /**
   * Get seen alert count
   */
  getSeenAlertCount(): number {
    return this.seenAlerts.size;
  }

  private async poll(): Promise<void> {
    try {
      const states = this.config.states ?? [];
      const alerts = states.length > 0
        ? await this.fetchAlertsForStates(states)
        : await this.fetchActiveAlerts();

      let newCount = 0;

      for (const alert of alerts) {
        // Skip if already seen
        if (this.seenAlerts.has(alert.id)) continue;

        // Skip minor alerts if configured
        if (!this.config.includeMinor && alert.severity === 'Minor') continue;

        // Mark as seen
        this.seenAlerts.add(alert.id);

        // Check if high-impact
        if (this.isHighImpact(alert)) {
          const event = this.alertToEvent(alert);
          this.emit('alert', event);
          newCount++;
        }
      }

      this.lastPollTime = Date.now();

      // Clean up old seen alerts (keep last 1000)
      if (this.seenAlerts.size > 1000) {
        const arr = [...this.seenAlerts];
        this.seenAlerts = new Set(arr.slice(-500));
      }

      if (newCount > 0) {
        console.log(`[Weather] ${newCount} new high-impact alerts`);
      }
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }

  private isHighImpact(alert: NWSAlert): boolean {
    // Check event type
    if (HIGH_IMPACT_EVENTS.includes(alert.event)) {
      return true;
    }

    // Check severity
    if (alert.severity === 'Extreme' || alert.severity === 'Severe') {
      return true;
    }

    // Check for hurricane-related keywords
    const text = `${alert.event} ${alert.headline}`.toLowerCase();
    if (
      text.includes('hurricane') ||
      text.includes('tropical storm') ||
      text.includes('tropical cyclone') ||
      text.includes('storm surge')
    ) {
      return true;
    }

    return false;
  }

  private alertToEvent(alert: NWSAlert): WeatherEvent {
    // Extract states from area description
    const states = this.extractStates(alert.areaDesc);

    return {
      id: alert.id || randomUUID(),
      type: 'alert',
      timestamp: Date.now(),
      source: 'NWS',
      event: alert.event,
      severity: alert.severity,
      urgency: alert.urgency,
      certainty: alert.certainty,
      areas: [alert.areaDesc],
      states,
      headline: alert.headline,
      description: alert.description,
      instruction: alert.instruction,
      effective: alert.effective,
      expires: alert.expires,
      significance: this.calculateSignificance(alert),
    };
  }

  private calculateSignificance(alert: NWSAlert): WeatherEvent['significance'] {
    // Hurricane warnings are always critical
    if (alert.event.includes('Hurricane Warning')) {
      return 'critical';
    }

    // Extreme severity
    if (alert.severity === 'Extreme') {
      return 'critical';
    }

    // Severe severity or hurricane-related
    if (
      alert.severity === 'Severe' ||
      alert.event.includes('Hurricane') ||
      alert.event.includes('Tropical Storm Warning')
    ) {
      return 'high';
    }

    // Watches and moderate severity
    if (
      alert.severity === 'Moderate' ||
      alert.event.includes('Watch')
    ) {
      return 'medium';
    }

    return 'low';
  }

  private extractStates(areaDesc: string): string[] {
    // Common patterns: "County A, FL; County B, FL" or "Florida"
    const statePattern = /\b([A-Z]{2})\b/g;
    const matches = areaDesc.match(statePattern) || [];

    // Filter to valid US states
    const validStates = [
      'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
      'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
      'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
      'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
      'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
      'DC', 'PR', 'VI',
    ];

    return [...new Set(matches.filter((s) => validStates.includes(s)))];
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

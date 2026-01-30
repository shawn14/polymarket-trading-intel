/**
 * Alert Engine
 *
 * Dispatches alerts to configured channels (console, webhook, file).
 * Handles deduplication, rate limiting, and priority filtering.
 */

import { EventEmitter } from 'events';
import { appendFile } from 'fs/promises';
import type { Signal } from '../signals/types.js';
import type { LinkedAlert } from '../signals/truth-change/types.js';
import type { BillStatusChange } from '../ingestion/congress/types.js';
import type { WeatherEvent } from '../ingestion/weather/types.js';
import type { FedEvent } from '../ingestion/fed/types.js';
import type { SportsEvent } from '../ingestion/sports/types.js';
import type {
  Alert,
  AlertPriority,
  AlertEngineConfig,
  ChannelConfig,
  ConsoleChannelConfig,
  WebhookChannelConfig,
  FileChannelConfig,
} from './types.js';
import { PRIORITY_ORDER } from './types.js';
import {
  formatSignalAlert,
  formatCongressAlert,
  formatWeatherAlert,
  formatFedAlert,
  formatSportsAlert,
  formatLinkedAlert,
  formatForConsole,
  formatForWebhook,
  formatForFile,
} from './formatter.js';

const DEFAULT_DEDUPE_WINDOW_MS = 60 * 1000; // 1 minute
const DEFAULT_RATE_LIMIT = 60; // 60 alerts per minute
const DEFAULT_WEBHOOK_TIMEOUT_MS = 10000;
const DEFAULT_WEBHOOK_RETRIES = 2;

export interface AlertEngineEvents {
  alert: [alert: Alert];
  sent: [alert: Alert, channel: string];
  error: [error: Error, channel: string];
}

export class AlertEngine extends EventEmitter<AlertEngineEvents> {
  private config: AlertEngineConfig;
  private recentAlerts: Map<string, number> = new Map(); // hash -> timestamp
  private alertTimestamps: number[] = []; // for rate limiting

  constructor(config: AlertEngineConfig) {
    super();
    this.config = {
      dedupeWindowMs: DEFAULT_DEDUPE_WINDOW_MS,
      rateLimitPerMinute: DEFAULT_RATE_LIMIT,
      ...config,
    };
  }

  /**
   * Send a market signal as an alert
   */
  sendSignal(signal: Signal): void {
    const alert = formatSignalAlert(signal);
    this.dispatch(alert);
  }

  /**
   * Send a Congress bill change as an alert
   */
  sendCongressChange(change: BillStatusChange): void {
    const alert = formatCongressAlert(change);
    this.dispatch(alert);
  }

  /**
   * Send a linked alert (truth source → market)
   */
  sendLinkedAlert(linkedAlert: LinkedAlert): void {
    const alert = formatLinkedAlert(linkedAlert);
    this.dispatch(alert);
  }

  /**
   * Send a weather event as an alert
   */
  sendWeatherEvent(event: WeatherEvent): void {
    const alert = formatWeatherAlert(event);
    this.dispatch(alert);
  }

  /**
   * Send a Fed event as an alert
   */
  sendFedEvent(event: FedEvent): void {
    const alert = formatFedAlert(event);
    this.dispatch(alert);
  }

  /**
   * Send a sports event as an alert
   */
  sendSportsEvent(event: SportsEvent): void {
    const alert = formatSportsAlert(event);
    this.dispatch(alert);
  }

  /**
   * Send a custom alert
   */
  sendCustom(
    title: string,
    body: string,
    priority: AlertPriority = 'medium',
    metadata: Record<string, unknown> = {}
  ): void {
    const alert: Alert = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      priority,
      source: { type: 'custom', category: 'custom' },
      title,
      body,
      metadata,
    };
    this.dispatch(alert);
  }

  /**
   * Get current rate (alerts per minute)
   */
  getCurrentRate(): number {
    const oneMinuteAgo = Date.now() - 60000;
    this.alertTimestamps = this.alertTimestamps.filter((t) => t > oneMinuteAgo);
    return this.alertTimestamps.length;
  }

  /**
   * Main dispatch method
   */
  private dispatch(alert: Alert): void {
    // Check deduplication
    if (this.isDuplicate(alert)) {
      return;
    }

    // Check rate limit
    if (this.isRateLimited()) {
      console.warn('[AlertEngine] Rate limit exceeded, dropping alert:', alert.title);
      return;
    }

    // Record for deduplication and rate limiting
    this.recordAlert(alert);

    // Emit event
    this.emit('alert', alert);

    // Send to all configured channels
    for (const channel of this.config.channels) {
      this.sendToChannel(alert, channel);
    }
  }

  /**
   * Send alert to a specific channel
   */
  private async sendToChannel(alert: Alert, channel: ChannelConfig): Promise<void> {
    // Check priority filter
    if (channel.minPriority && !this.meetsPriority(alert.priority, channel.minPriority)) {
      return;
    }

    try {
      switch (channel.type) {
        case 'console':
          this.sendToConsole(alert, channel);
          break;
        case 'webhook':
          await this.sendToWebhook(alert, channel);
          break;
        case 'file':
          await this.sendToFile(alert, channel);
          break;
      }
      this.emit('sent', alert, channel.type);
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)), channel.type);
    }
  }

  /**
   * Send to console
   */
  private sendToConsole(alert: Alert, config: ConsoleChannelConfig): void {
    const output = formatForConsole(alert, config.colorize ?? true);
    console.log(output);
  }

  /**
   * Send to webhook
   */
  private async sendToWebhook(alert: Alert, config: WebhookChannelConfig): Promise<void> {
    const payload = formatForWebhook(alert);
    const timeoutMs = config.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
    const maxRetries = config.retries ?? DEFAULT_WEBHOOK_RETRIES;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(config.url, {
          method: config.method ?? 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...config.headers,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          throw new Error(`Webhook returned ${response.status}`);
        }

        return; // Success
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries) {
          await this.delay(1000 * (attempt + 1)); // Exponential backoff
        }
      }
    }

    throw lastError;
  }

  /**
   * Send to file
   */
  private async sendToFile(alert: Alert, config: FileChannelConfig): Promise<void> {
    const content = formatForFile(alert, config.format ?? 'json');
    await appendFile(config.path, content, 'utf-8');
  }

  /**
   * Check if alert is a duplicate
   */
  private isDuplicate(alert: Alert): boolean {
    const hash = this.hashAlert(alert);
    const lastSeen = this.recentAlerts.get(hash);

    if (lastSeen) {
      const dedupeWindow = this.config.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
      if (Date.now() - lastSeen < dedupeWindow) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if rate limited
   */
  private isRateLimited(): boolean {
    const limit = this.config.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT;
    return this.getCurrentRate() >= limit;
  }

  /**
   * Record alert for deduplication and rate limiting
   */
  private recordAlert(alert: Alert): void {
    const hash = this.hashAlert(alert);
    this.recentAlerts.set(hash, Date.now());
    this.alertTimestamps.push(Date.now());

    // Clean up old entries
    const dedupeWindow = this.config.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    const cutoff = Date.now() - dedupeWindow;

    for (const [key, timestamp] of this.recentAlerts) {
      if (timestamp < cutoff) {
        this.recentAlerts.delete(key);
      }
    }
  }

  /**
   * Create a hash for deduplication
   */
  private hashAlert(alert: Alert): string {
    // Hash based on source type, title, and key content
    return `${alert.source.type}:${alert.title}:${alert.priority}`;
  }

  /**
   * Check if alert priority meets minimum
   */
  private meetsPriority(alertPriority: AlertPriority, minPriority: AlertPriority): boolean {
    return PRIORITY_ORDER[alertPriority] >= PRIORITY_ORDER[minPriority];
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

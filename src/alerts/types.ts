/**
 * Alert System Types
 */

import type { Signal } from '../signals/types.js';
import type { LinkedAlert } from '../signals/truth-change/types.js';
import type { BillStatusChange } from '../ingestion/congress/types.js';

// Alert priority levels
export type AlertPriority = 'low' | 'medium' | 'high' | 'critical';

// Alert channels
export type AlertChannel = 'console' | 'webhook' | 'file';

// Unified alert envelope
export interface Alert {
  id: string;
  timestamp: number;
  priority: AlertPriority;
  source: AlertSource;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
}

// Alert sources
export type AlertSource =
  | { type: 'signal'; signal: Signal }
  | { type: 'congress'; billChange: BillStatusChange }
  | { type: 'linked'; linkedAlert: LinkedAlert }
  | { type: 'custom'; category: string };

// Channel configuration
export interface ConsoleChannelConfig {
  type: 'console';
  minPriority?: AlertPriority;
  colorize?: boolean;
}

export interface WebhookChannelConfig {
  type: 'webhook';
  url: string;
  method?: 'POST' | 'PUT';
  headers?: Record<string, string>;
  minPriority?: AlertPriority;
  retries?: number;
  timeoutMs?: number;
}

export interface FileChannelConfig {
  type: 'file';
  path: string;
  format?: 'json' | 'text';
  minPriority?: AlertPriority;
}

export type ChannelConfig = ConsoleChannelConfig | WebhookChannelConfig | FileChannelConfig;

// Alert engine configuration
export interface AlertEngineConfig {
  channels: ChannelConfig[];
  dedupeWindowMs?: number; // Prevent duplicate alerts within window
  rateLimitPerMinute?: number; // Max alerts per minute
}

// Webhook payload format
export interface WebhookPayload {
  id: string;
  timestamp: string;
  priority: AlertPriority;
  title: string;
  body: string;
  source: string;
  metadata: Record<string, unknown>;
}

// Priority ordering for comparison
export const PRIORITY_ORDER: Record<AlertPriority, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

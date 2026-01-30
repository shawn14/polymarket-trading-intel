/**
 * Alert Formatter
 *
 * Converts various event types into unified Alert format.
 */

import { randomUUID } from 'crypto';
import type { Signal } from '../signals/types.js';
import type { LinkedAlert } from '../signals/truth-change/types.js';
import type { BillStatusChange } from '../ingestion/congress/types.js';
import type { WeatherEvent } from '../ingestion/weather/types.js';
import type { FedEvent } from '../ingestion/fed/types.js';
import type { SportsEvent } from '../ingestion/sports/types.js';
import type { Alert, AlertPriority } from './types.js';

/**
 * Format a market signal into an alert
 */
export function formatSignalAlert(signal: Signal): Alert {
  const priority = signalStrengthToPriority(signal.strength);

  return {
    id: signal.id,
    timestamp: signal.timestamp,
    priority,
    source: { type: 'signal', signal },
    title: `${signal.type.toUpperCase()}: ${signal.assetId.slice(0, 8)}...`,
    body: signal.description,
    metadata: {
      assetId: signal.assetId,
      market: signal.market,
      signalType: signal.type,
      signalData: signal.data,
    },
  };
}

/**
 * Format a Congress bill change into an alert
 */
export function formatCongressAlert(change: BillStatusChange): Alert {
  const priority = billSignificanceToPriority(change.significance);
  const billId = `${change.bill.type} ${change.bill.number}`;

  return {
    id: randomUUID(),
    timestamp: Date.now(),
    priority,
    source: { type: 'congress', billChange: change },
    title: `CONGRESS: ${billId} - ${change.action.type}`,
    body: `${change.bill.title}\n\nAction: ${change.action.text}`,
    metadata: {
      billId,
      billTitle: change.bill.title,
      actionType: change.action.type,
      actionText: change.action.text,
      isNew: change.isNew,
      congress: change.bill.congress,
    },
  };
}

/**
 * Format a Fed event into an alert
 */
export function formatFedAlert(event: FedEvent): Alert {
  const priority = fedSignificanceToPriority(event.significance);

  let body = `${event.description}\n\n`;
  body += `Type: ${event.type}\n`;

  if (event.rateDecision) {
    body += `Rate Decision: ${event.rateDecision.toUpperCase()}`;
    if (event.rateChange) {
      body += ` (${event.rateChange > 0 ? '+' : ''}${event.rateChange} bps)`;
    }
    body += '\n';
  }

  if (event.sentiment) {
    body += `Sentiment: ${event.sentiment}\n`;
  }

  body += `\nURL: ${event.url}`;

  return {
    id: event.id,
    timestamp: event.timestamp,
    priority,
    source: { type: 'custom', category: 'fed' },
    title: `FED: ${event.title.slice(0, 60)}`,
    body,
    metadata: {
      type: event.type,
      rateDecision: event.rateDecision,
      rateChange: event.rateChange,
      sentiment: event.sentiment,
      url: event.url,
    },
  };
}

/**
 * Format a weather event into an alert
 */
export function formatWeatherAlert(event: WeatherEvent): Alert {
  const priority = weatherSignificanceToPriority(event.significance);

  let body = `${event.headline}\n\n`;
  body += `Areas: ${event.areas.join(', ')}\n`;
  body += `States: ${event.states.join(', ')}\n`;
  body += `Severity: ${event.severity} | Urgency: ${event.urgency}\n`;
  body += `Effective: ${event.effective}\n`;
  body += `Expires: ${event.expires}\n`;

  if (event.instruction) {
    body += `\nInstructions: ${event.instruction}`;
  }

  return {
    id: event.id,
    timestamp: event.timestamp,
    priority,
    source: { type: 'custom', category: 'weather' },
    title: `WEATHER: ${event.event}`,
    body,
    metadata: {
      event: event.event,
      severity: event.severity,
      urgency: event.urgency,
      certainty: event.certainty,
      states: event.states,
      areas: event.areas,
    },
  };
}

/**
 * Format a sports event into an alert
 */
export function formatSportsAlert(event: SportsEvent): Alert {
  const priority = sportsSignificanceToPriority(event.significance);

  let body = event.details + '\n';

  if (event.injury) {
    const inj = event.injury;
    if (inj.isUpdate && inj.previousStatus) {
      body += `\nStatus changed from ${inj.previousStatus.toUpperCase()} to ${inj.status.toUpperCase()}`;
    }
    if (inj.gameDate) {
      body += `\nGame: ${inj.gameDate}`;
    }
  }

  return {
    id: event.id,
    timestamp: event.timestamp,
    priority,
    source: { type: 'custom', category: 'sports' },
    title: `SPORTS: ${event.headline}`,
    body,
    metadata: {
      league: event.league,
      type: event.type,
      player: event.injury?.player,
      team: event.injury?.team,
      status: event.injury?.status,
      previousStatus: event.injury?.previousStatus,
    },
  };
}

/**
 * Format a linked alert (truth source → market)
 */
export function formatLinkedAlert(alert: LinkedAlert): Alert {
  const priority = linkedUrgencyToPriority(alert.urgency);

  // Build detailed body
  let body = `${alert.summary}\n\n`;

  if (alert.affectedMarkets.length > 0) {
    body += `AFFECTED MARKETS:\n`;
    for (const market of alert.affectedMarkets) {
      const arrow = market.expectedDirection === 'up' ? '↑' :
        market.expectedDirection === 'down' ? '↓' : '?';
      body += `${arrow} ${market.question}\n`;
      body += `  Current: ${(market.currentPrice * 100).toFixed(0)}% | ${market.reasoning}\n`;
    }
  }

  if (alert.implications.length > 0) {
    body += `\nIMPLICATIONS:\n`;
    for (const imp of alert.implications) {
      body += `• ${imp}\n`;
    }
  }

  return {
    id: alert.id,
    timestamp: alert.timestamp,
    priority,
    source: { type: 'linked', linkedAlert: alert },
    title: alert.headline,
    body,
    metadata: {
      sourceType: alert.sourceType,
      confidence: alert.confidence,
      urgency: alert.urgency,
      affectedMarketCount: alert.affectedMarkets.length,
      marketIds: alert.affectedMarkets.map((m) => m.marketId),
    },
  };
}

/**
 * Format alert for console output
 */
export function formatForConsole(alert: Alert, colorize = true): string {
  const time = new Date(alert.timestamp).toLocaleTimeString();
  const indicator = getPriorityIndicator(alert.priority);

  let output = '';

  if (alert.priority === 'critical' || alert.priority === 'high') {
    output += '\n' + '='.repeat(70) + '\n';
  }

  output += `[${time}] ${indicator} ${alert.priority.toUpperCase()} | ${alert.title}\n`;
  output += '-'.repeat(50) + '\n';
  output += alert.body + '\n';

  if (alert.priority === 'critical' || alert.priority === 'high') {
    output += '='.repeat(70);
  }

  return output;
}

/**
 * Format alert for webhook payload
 */
export function formatForWebhook(alert: Alert): object {
  return {
    id: alert.id,
    timestamp: new Date(alert.timestamp).toISOString(),
    priority: alert.priority,
    title: alert.title,
    body: alert.body,
    source: alert.source.type,
    metadata: alert.metadata,
  };
}

/**
 * Format alert for file logging
 */
export function formatForFile(alert: Alert, format: 'json' | 'text' = 'json'): string {
  if (format === 'json') {
    return JSON.stringify({
      id: alert.id,
      timestamp: new Date(alert.timestamp).toISOString(),
      priority: alert.priority,
      title: alert.title,
      body: alert.body,
      source: alert.source.type,
      metadata: alert.metadata,
    }) + '\n';
  }

  // Text format
  const time = new Date(alert.timestamp).toISOString();
  return `[${time}] [${alert.priority.toUpperCase()}] ${alert.title}\n${alert.body}\n---\n`;
}

// Helper functions

function signalStrengthToPriority(strength: Signal['strength']): AlertPriority {
  switch (strength) {
    case 'very_high': return 'critical';
    case 'high': return 'high';
    case 'medium': return 'medium';
    default: return 'low';
  }
}

function billSignificanceToPriority(significance: BillStatusChange['significance']): AlertPriority {
  switch (significance) {
    case 'critical': return 'critical';
    case 'high': return 'high';
    case 'medium': return 'medium';
    default: return 'low';
  }
}

function linkedUrgencyToPriority(urgency: LinkedAlert['urgency']): AlertPriority {
  return urgency; // Same enum values
}

function weatherSignificanceToPriority(significance: WeatherEvent['significance']): AlertPriority {
  switch (significance) {
    case 'critical': return 'critical';
    case 'high': return 'high';
    case 'medium': return 'medium';
    default: return 'low';
  }
}

function fedSignificanceToPriority(significance: FedEvent['significance']): AlertPriority {
  switch (significance) {
    case 'critical': return 'critical';
    case 'high': return 'high';
    case 'medium': return 'medium';
    default: return 'low';
  }
}

function sportsSignificanceToPriority(significance: SportsEvent['significance']): AlertPriority {
  switch (significance) {
    case 'critical': return 'critical';
    case 'high': return 'high';
    case 'medium': return 'medium';
    default: return 'low';
  }
}

function getPriorityIndicator(priority: AlertPriority): string {
  switch (priority) {
    case 'critical': return '◈';
    case 'high': return '◉';
    case 'medium': return '●';
    default: return '○';
  }
}

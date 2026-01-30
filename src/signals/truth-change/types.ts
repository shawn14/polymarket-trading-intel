/**
 * Truth-Market Linker Types
 *
 * Maps truth source events to affected Polymarket markets.
 */

import type { Signal } from '../types.js';
import type { BillStatusChange } from '../../ingestion/congress/types.js';

// Supported truth source types
export type TruthSourceType = 'congress' | 'weather' | 'fed' | 'sports' | 'geopolitical';

// Market category for matching
export type MarketCategory =
  | 'government_shutdown'
  | 'legislation'
  | 'appropriations'
  | 'fed_rate'
  | 'hurricane'
  | 'weather'
  | 'sports_outcome'
  | 'sports_player'
  | 'geopolitical'
  | 'other';

// Truth map defines how a market connects to truth sources
export interface TruthMap {
  marketId: string;
  category: MarketCategory;
  keywords: string[]; // Keywords to match in market question/description
  truthSources: TruthSourceType[];

  // For Congress-related markets
  billPatterns?: RegExp[]; // Patterns to match bill titles
  billTypes?: string[]; // Bill types to watch (HR, S, etc.)

  // For weather markets
  weatherRegions?: string[];
  weatherEventTypes?: string[];

  // For Fed markets
  fedEventTypes?: string[];

  // For sports markets
  sportsLeagues?: string[];
  sportsTeams?: string[];
  sportsPlayers?: string[];
}

// A linked alert combines truth source data with market context
export interface LinkedAlert {
  id: string;
  timestamp: number;

  // Source event
  sourceType: TruthSourceType;
  sourceEvent: TruthSourceEvent;

  // Affected markets
  affectedMarkets: AffectedMarket[];

  // Overall assessment
  confidence: 'low' | 'medium' | 'high' | 'very_high';
  urgency: 'low' | 'medium' | 'high' | 'critical';

  // Human-readable summary
  headline: string;
  summary: string;
  implications: string[];
}

// Union of all truth source events
export type TruthSourceEvent =
  | CongressEvent
  | WeatherEvent
  | FedEvent
  | SportsEvent
  | GeopoliticalEvent;

export interface CongressEvent {
  type: 'congress';
  billChange: BillStatusChange;
  billId: string;
  billTitle: string;
  actionType: string;
  actionText: string;
}

export interface WeatherEvent {
  type: 'weather';
  alertType: string;
  region: string;
  severity: string;
  headline: string;
}

export interface FedEvent {
  type: 'fed';
  eventType: 'statement' | 'minutes' | 'speech' | 'rate_decision';
  content: string;
  rateChange?: number;
}

export interface SportsEvent {
  type: 'sports';
  league: string;
  eventType: 'injury' | 'lineup' | 'result' | 'trade';
  team?: string;
  player?: string;
  details: string;
}

export interface GeopoliticalEvent {
  type: 'geopolitical';
  eventType: string;
  region: string;
  headline: string;
  source: string;
}

// Market affected by a truth source event
export interface AffectedMarket {
  marketId: string;
  conditionId: string;
  question: string;
  slug: string;

  // Current market state
  currentPrice: number;

  // How this event affects the market
  relevanceScore: number; // 0-1, how relevant is this event
  expectedDirection: 'up' | 'down' | 'uncertain';
  reasoning: string;
}

// Registry entry for a tracked market
export interface TrackedMarket {
  marketId: string;
  conditionId: string;
  question: string;
  slug: string;
  description: string;
  tokenIds: string[];
  currentPrices: number[];
  truthMap: TruthMap;
  lastUpdated: number;
}

// Predefined truth maps for common market categories
export const SHUTDOWN_TRUTH_MAP: Partial<TruthMap> = {
  category: 'government_shutdown',
  keywords: ['shutdown', 'government shutdown', 'federal shutdown', 'lapse'],
  truthSources: ['congress'],
  billPatterns: [
    /appropriation/i,
    /continuing resolution/i,
    /continuing appropriations/i,
    /omnibus/i,
    /minibus/i,
    /government funding/i,
    /full.year.*funding/i,
  ],
  billTypes: ['hr', 's', 'hjres', 'sjres'],
};

export const LEGISLATION_TRUTH_MAP: Partial<TruthMap> = {
  category: 'legislation',
  keywords: ['legislation', 'congress pass', 'senate pass', 'house pass', 'signed into law', 'becomes law'],
  truthSources: ['congress'],
};

export const FED_RATE_TRUTH_MAP: Partial<TruthMap> = {
  category: 'fed_rate',
  keywords: [
    'federal reserve',
    'rate cut',
    'rate hike',
    'fomc',
    'interest rate',
    'fed funds',
    'fed rate',
    'federal funds rate',
    'basis points',
    'powell',
  ],
  truthSources: ['fed'],
  fedEventTypes: ['rate_decision', 'statement'],
};

export const HURRICANE_TRUTH_MAP: Partial<TruthMap> = {
  category: 'hurricane',
  keywords: ['hurricane', 'tropical storm', 'landfall', 'category'],
  truthSources: ['weather'],
  weatherEventTypes: ['hurricane', 'tropical_storm'],
};

export const SPORTS_PLAYER_TRUTH_MAP: Partial<TruthMap> = {
  category: 'sports_player',
  keywords: [
    'points', 'rebounds', 'assists', 'touchdowns', 'yards', 'receptions',
    'goals', 'saves', 'hits', 'strikeouts', 'home runs',
    'o/u', 'over/under', 'prop',
  ],
  truthSources: ['sports'],
  sportsLeagues: ['NFL', 'NBA', 'MLB', 'NHL'],
};

export const SPORTS_OUTCOME_TRUTH_MAP: Partial<TruthMap> = {
  category: 'sports_outcome',
  keywords: [
    'win', 'beat', 'defeat', 'champion', 'championship', 'super bowl',
    'world series', 'finals', 'playoff', 'make playoffs',
  ],
  truthSources: ['sports'],
  sportsLeagues: ['NFL', 'NBA', 'MLB', 'NHL', 'EPL', 'MLS'],
};

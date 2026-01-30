/**
 * Watchlist Types
 *
 * Data structures for user-defined market watchlists.
 * Allows targeted alerts only when truth sources impact watched markets.
 */

import type { TruthSourceType, MarketCategory } from '../signals/truth-change/types.js';

// Truth sources available for watching
export type TruthSource = TruthSourceType | 'news';

// Watchlist root structure
export interface Watchlist {
  version: 1;
  markets: WatchedMarket[];
  createdAt: number;
  updatedAt: number;
}

// A single market being watched
export interface WatchedMarket {
  marketId: string;           // Polymarket market ID
  conditionId: string;        // Condition ID for the market
  question: string;           // Market question text

  // What to monitor (user-defined or auto-detected)
  truthSources: TruthSource[];
  keywords: string[];         // Custom keywords to match

  // Alert preferences
  minConfidence: 'low' | 'medium' | 'high';  // Minimum confidence to trigger alert

  // Metadata
  addedAt: number;
  notes?: string;             // Optional user notes
}

// Input for adding a market to watchlist (minimal required fields)
export interface AddMarketInput {
  marketId: string;
  conditionId: string;
  question: string;

  // Optional overrides (otherwise auto-detected)
  truthSources?: TruthSource[];
  keywords?: string[];
  minConfidence?: 'low' | 'medium' | 'high';
  notes?: string;
}

// Partial update for a watched market
export interface UpdateMarketInput {
  truthSources?: TruthSource[];
  keywords?: string[];
  minConfidence?: 'low' | 'medium' | 'high';
  notes?: string;
}

// Auto-detection result for a market question
export interface DetectedSources {
  category: MarketCategory;
  truthSources: TruthSource[];
  keywords: string[];
}

// Match result when checking if an event affects watched markets
export interface WatchlistMatch {
  market: WatchedMarket;
  relevanceScore: number;     // 0-1, how relevant the event is to this market
  matchedKeywords: string[];  // Which keywords matched
}

// Empty watchlist factory
export function createEmptyWatchlist(): Watchlist {
  return {
    version: 1,
    markets: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Watchlist Manager
 *
 * Handles CRUD operations, persistence, and matching for user watchlists.
 * Auto-detects appropriate truth sources and keywords from market questions.
 */

import { readFile, writeFile, access } from 'fs/promises';
import { constants } from 'fs';
import type {
  Watchlist,
  WatchedMarket,
  AddMarketInput,
  UpdateMarketInput,
  DetectedSources,
  WatchlistMatch,
  TruthSource,
} from './types.js';
import { createEmptyWatchlist } from './types.js';
import type { TruthSourceEvent, MarketCategory } from '../signals/truth-change/types.js';

// Keyword patterns for auto-detection
const DETECTION_PATTERNS: Array<{
  patterns: RegExp[];
  category: MarketCategory;
  truthSources: TruthSource[];
  keywords: string[];
}> = [
  {
    patterns: [/shutdown/i, /appropriations?/i, /continuing\s+resolution/i, /CR\b/i, /omnibus/i, /minibus/i, /funding\s+gap/i],
    category: 'government_shutdown',
    truthSources: ['congress'],
    keywords: ['shutdown', 'continuing resolution', 'CR', 'appropriations', 'omnibus', 'funding'],
  },
  {
    patterns: [/federal\s+reserve/i, /\bfed\b/i, /fomc/i, /rate\s+(cut|hike)/i, /interest\s+rate/i, /basis\s+points/i, /powell/i],
    category: 'fed_rate',
    truthSources: ['fed'],
    keywords: ['rate cut', 'rate hike', 'FOMC', 'basis points', 'interest rate', 'Fed'],
  },
  {
    patterns: [/hurricane/i, /tropical\s+storm/i, /landfall/i, /category\s+\d/i, /NHC/i],
    category: 'hurricane',
    truthSources: ['weather'],
    keywords: ['hurricane', 'landfall', 'tropical storm', 'category', 'NHC'],
  },
  {
    patterns: [/\bNFL\b/i, /\bNBA\b/i, /\bMLB\b/i, /\bNHL\b/i, /super\s+bowl/i, /world\s+series/i, /\bfinals\b/i, /playoff/i],
    category: 'sports_outcome',
    truthSources: ['sports'],
    keywords: ['win', 'championship', 'playoffs', 'series'],
  },
  {
    patterns: [/points/i, /rebounds/i, /assists/i, /touchdowns?/i, /yards/i, /receptions?/i, /goals?/i, /o\/u/i, /over\s*\/?\s*under/i, /prop/i],
    category: 'sports_player',
    truthSources: ['sports'],
    keywords: ['injury', 'status', 'out', 'questionable', 'lineup'],
  },
  {
    patterns: [/congress/i, /senate/i, /house\s+(of\s+representatives)?/i, /legislation/i, /bill\s+pass/i, /law\b/i, /signed\s+into\s+law/i],
    category: 'legislation',
    truthSources: ['congress'],
    keywords: ['legislation', 'congress', 'senate', 'house', 'signed into law'],
  },
];

// Star player names for sports detection
const STAR_PLAYERS = [
  // NFL
  'mahomes', 'allen', 'hurts', 'burrow', 'herbert', 'jackson', 'hill', 'kelce', 'chase', 'jefferson',
  // NBA
  'lebron', 'curry', 'durant', 'giannis', 'jokic', 'embiid', 'tatum', 'luka', 'doncic', 'booker',
  // MLB
  'ohtani', 'trout', 'judge', 'soto', 'acuna', 'betts', 'freeman', 'tatis',
];

export class WatchlistManager {
  private watchlist: Watchlist;
  private filePath: string;
  private loaded: boolean = false;

  constructor(filePath: string = './watchlist.json') {
    this.filePath = filePath;
    this.watchlist = createEmptyWatchlist();
  }

  /**
   * Load watchlist from disk
   */
  async load(): Promise<Watchlist> {
    try {
      await access(this.filePath, constants.R_OK);
      const data = await readFile(this.filePath, 'utf-8');
      this.watchlist = JSON.parse(data) as Watchlist;
      this.loaded = true;
    } catch (err) {
      // File doesn't exist or can't be read - use empty watchlist
      this.watchlist = createEmptyWatchlist();
      this.loaded = true;
    }
    return this.watchlist;
  }

  /**
   * Save watchlist to disk
   */
  async save(): Promise<void> {
    this.watchlist.updatedAt = Date.now();
    await writeFile(this.filePath, JSON.stringify(this.watchlist, null, 2), 'utf-8');
  }

  /**
   * Get the current watchlist
   */
  getWatchlist(): Watchlist {
    return this.watchlist;
  }

  /**
   * Add a market to the watchlist
   */
  addMarket(input: AddMarketInput): WatchedMarket {
    // Check for duplicate
    if (this.isWatched(input.marketId)) {
      throw new Error(`Market ${input.marketId} is already in watchlist`);
    }

    // Auto-detect sources and keywords if not provided
    const detected = this.detectTruthSources(input.question);

    const market: WatchedMarket = {
      marketId: input.marketId,
      conditionId: input.conditionId,
      question: input.question,
      truthSources: input.truthSources ?? detected.truthSources,
      keywords: input.keywords ?? detected.keywords,
      minConfidence: input.minConfidence ?? 'medium',
      addedAt: Date.now(),
      notes: input.notes,
    };

    this.watchlist.markets.push(market);
    this.watchlist.updatedAt = Date.now();

    return market;
  }

  /**
   * Remove a market from the watchlist
   */
  removeMarket(marketId: string): boolean {
    const index = this.watchlist.markets.findIndex(m => m.marketId === marketId);
    if (index === -1) {
      return false;
    }
    this.watchlist.markets.splice(index, 1);
    this.watchlist.updatedAt = Date.now();
    return true;
  }

  /**
   * Update a market's settings
   */
  updateMarket(marketId: string, updates: UpdateMarketInput): WatchedMarket | null {
    const market = this.watchlist.markets.find(m => m.marketId === marketId);
    if (!market) {
      return null;
    }

    if (updates.truthSources !== undefined) {
      market.truthSources = updates.truthSources;
    }
    if (updates.keywords !== undefined) {
      market.keywords = updates.keywords;
    }
    if (updates.minConfidence !== undefined) {
      market.minConfidence = updates.minConfidence;
    }
    if (updates.notes !== undefined) {
      market.notes = updates.notes;
    }

    this.watchlist.updatedAt = Date.now();
    return market;
  }

  /**
   * Get a watched market by ID
   */
  getMarket(marketId: string): WatchedMarket | undefined {
    return this.watchlist.markets.find(m => m.marketId === marketId);
  }

  /**
   * Check if a market is in the watchlist
   */
  isWatched(marketId: string): boolean {
    return this.watchlist.markets.some(m => m.marketId === marketId);
  }

  /**
   * Find watched markets that match a truth source event
   */
  findMatchingMarkets(event: TruthSourceEvent): WatchlistMatch[] {
    const matches: WatchlistMatch[] = [];

    for (const market of this.watchlist.markets) {
      // Check if market watches this truth source type
      if (!market.truthSources.includes(event.type as TruthSource)) {
        continue;
      }

      // Calculate relevance score based on keyword matching
      const { score, matchedKeywords } = this.calculateRelevance(market, event);

      if (score > 0) {
        matches.push({
          market,
          relevanceScore: score,
          matchedKeywords,
        });
      }
    }

    // Sort by relevance score descending
    matches.sort((a, b) => b.relevanceScore - a.relevanceScore);

    return matches;
  }

  /**
   * Calculate how relevant an event is to a watched market
   */
  private calculateRelevance(
    market: WatchedMarket,
    event: TruthSourceEvent
  ): { score: number; matchedKeywords: string[] } {
    const matchedKeywords: string[] = [];
    let score = 0;

    // Get event text to match against
    const eventText = this.getEventText(event).toLowerCase();

    // Check each keyword
    for (const keyword of market.keywords) {
      if (eventText.includes(keyword.toLowerCase())) {
        matchedKeywords.push(keyword);
        score += 0.2; // Each keyword match adds to score
      }
    }

    // Cap score at 1.0
    score = Math.min(score, 1.0);

    // Bonus for exact market question term match
    const questionTerms = market.question.toLowerCase().split(/\s+/);
    for (const term of questionTerms) {
      if (term.length > 4 && eventText.includes(term)) {
        score = Math.min(score + 0.1, 1.0);
      }
    }

    return { score, matchedKeywords };
  }

  /**
   * Extract searchable text from an event
   */
  private getEventText(event: TruthSourceEvent): string {
    switch (event.type) {
      case 'congress':
        return `${event.billTitle} ${event.actionText} ${event.actionType}`;
      case 'weather':
        return `${event.alertType} ${event.headline} ${event.region}`;
      case 'fed':
        return `${event.eventType} ${event.content}`;
      case 'sports':
        return `${event.league} ${event.player ?? ''} ${event.team ?? ''} ${event.details} ${event.eventType}`;
      case 'geopolitical':
        return `${event.headline} ${event.region} ${event.eventType}`;
      default:
        return '';
    }
  }

  /**
   * Auto-detect appropriate truth sources from a market question
   */
  detectTruthSources(question: string): DetectedSources {
    const lowerQuestion = question.toLowerCase();

    // Check each pattern group
    for (const group of DETECTION_PATTERNS) {
      for (const pattern of group.patterns) {
        if (pattern.test(question)) {
          return {
            category: group.category,
            truthSources: [...group.truthSources],
            keywords: [...group.keywords],
          };
        }
      }
    }

    // Check for star player names (sports)
    for (const player of STAR_PLAYERS) {
      if (lowerQuestion.includes(player)) {
        return {
          category: 'sports_player',
          truthSources: ['sports'],
          keywords: ['injury', 'status', 'out', 'questionable', player],
        };
      }
    }

    // Default to other with news as source
    return {
      category: 'other',
      truthSources: ['news'],
      keywords: [],
    };
  }

  /**
   * Suggest keywords based on market question
   */
  suggestKeywords(question: string): string[] {
    const detected = this.detectTruthSources(question);
    const keywords = [...detected.keywords];

    // Extract significant terms from the question
    const terms = question
      .toLowerCase()
      .split(/[\s,.\-?!]+/)
      .filter(t => t.length > 4)
      .filter(t => !['will', 'what', 'when', 'where', 'which', 'would', 'could', 'should', 'there', 'their', 'before', 'after'].includes(t));

    // Add unique significant terms
    for (const term of terms) {
      if (!keywords.some(k => k.toLowerCase() === term)) {
        keywords.push(term);
      }
    }

    return keywords.slice(0, 10); // Limit to 10 keywords
  }

  /**
   * Check if loaded
   */
  isLoaded(): boolean {
    return this.loaded;
  }
}

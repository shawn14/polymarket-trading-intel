/**
 * Leaderboard Enrichment
 *
 * Fetches top traders from Polymarket leaderboard for:
 * 1. Bootstrap (seed initial whale list before we have trade data)
 * 2. Name enrichment (display names for known whales)
 */

import type { LeaderboardEntry } from './types.js';

// Polymarket leaderboard API endpoint
const LEADERBOARD_API = 'https://lb-api.polymarket.com/profit';

// Category leaderboard endpoint (uses different API)
const CATEGORY_LEADERBOARD_API = 'https://polymarket.com/api/leaderboard';

// Valid leaderboard categories
export type LeaderboardCategory =
  | 'all'
  | 'crypto'
  | 'sports'
  | 'politics'
  | 'finance'
  | 'economy'
  | 'climate'
  | 'culture'
  | 'tech'
  | 'world'
  | 'geopolitics';

// Cache leaderboard data
let cachedLeaderboard: LeaderboardEntry[] = [];
let lastFetch = 0;
const CACHE_TTL = 1 * 60 * 60 * 1000; // 1 hour cache (refresh more frequently)

// Category-specific cache
const categoryCache = new Map<LeaderboardCategory, { entries: LeaderboardEntry[]; fetchedAt: number }>();
const CATEGORY_CACHE_TTL = 30 * 60 * 1000; // 30 minutes for category data

// Leaderboard API response type
interface LeaderboardAPIEntry {
  proxyWallet: string;
  amount: number;  // PnL in USDC
  pseudonym: string;
  name: string;
  bio: string;
  profileImage: string;
}

/**
 * Fetch leaderboard from Polymarket API
 */
export async function fetchLeaderboard(limit: number = 200): Promise<LeaderboardEntry[]> {
  const now = Date.now();

  // Return cached if fresh
  if (cachedLeaderboard.length > 0 && now - lastFetch < CACHE_TTL) {
    console.log(`[Leaderboard] Using cached data (${cachedLeaderboard.length} entries)`);
    return cachedLeaderboard;
  }

  try {
    console.log(`[Leaderboard] Fetching top ${limit} traders from Polymarket...`);

    const response = await fetch(`${LEADERBOARD_API}?limit=${limit}&window=all`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as LeaderboardAPIEntry[];

    // Transform API response to our format
    cachedLeaderboard = data.map((entry, index) => ({
      rank: index + 1,
      address: entry.proxyWallet,
      displayName: entry.name || entry.pseudonym || undefined,
      pnl: entry.amount,
      volume: 0, // Not provided by this endpoint
      positions: 0, // Not provided by this endpoint
    }));

    lastFetch = now;
    console.log(`[Leaderboard] Fetched ${cachedLeaderboard.length} top traders`);

    // Log top 5 for visibility
    for (const entry of cachedLeaderboard.slice(0, 5)) {
      const pnlStr = entry.pnl >= 1_000_000
        ? `$${(entry.pnl / 1_000_000).toFixed(1)}M`
        : `$${(entry.pnl / 1_000).toFixed(0)}k`;
      console.log(`  #${entry.rank} ${entry.displayName || entry.address.slice(0, 10)} - ${pnlStr}`);
    }

    return cachedLeaderboard;

  } catch (error) {
    console.error('[Leaderboard] Failed to fetch leaderboard:', error);
    // Return stale cache on error
    if (cachedLeaderboard.length > 0) {
      console.log('[Leaderboard] Using stale cache');
    }
    return cachedLeaderboard;
  }
}

/**
 * Get cached leaderboard entries
 */
export function getCachedLeaderboard(): LeaderboardEntry[] {
  return cachedLeaderboard;
}

/**
 * Manually seed leaderboard data
 * Useful for initial bootstrap or testing
 */
export function seedLeaderboard(entries: LeaderboardEntry[]): void {
  cachedLeaderboard = entries;
  lastFetch = Date.now();
  console.log(`[Leaderboard] Seeded with ${entries.length} entries`);
}

/**
 * Parse address to display name mapping
 */
export function getDisplayName(address: string): string | undefined {
  const entry = cachedLeaderboard.find(
    e => e.address.toLowerCase() === address.toLowerCase()
  );
  return entry?.displayName;
}

/**
 * Get leaderboard rank for an address
 */
export function getRank(address: string): number | undefined {
  const entry = cachedLeaderboard.find(
    e => e.address.toLowerCase() === address.toLowerCase()
  );
  return entry?.rank;
}

/**
 * Check if address is on leaderboard
 */
export function isOnLeaderboard(address: string): boolean {
  return cachedLeaderboard.some(
    e => e.address.toLowerCase() === address.toLowerCase()
  );
}

/**
 * Get top N from leaderboard
 */
export function getTopN(n: number): LeaderboardEntry[] {
  return cachedLeaderboard.slice(0, n);
}

/**
 * Known whale addresses (hardcoded bootstrap)
 * These are well-known Polymarket traders
 */
export const KNOWN_WHALES: Array<{ address: string; name: string }> = [
  // Add known whale addresses here for bootstrap
  // This list can be populated from public sources
];

/**
 * Bootstrap whale list from known whales
 */
export function getBootstrapWhales(): LeaderboardEntry[] {
  return KNOWN_WHALES.map((w, i) => ({
    rank: i + 1,
    address: w.address,
    displayName: w.name,
    pnl: 0,
    volume: 0,
    positions: 0,
  }));
}

/**
 * Fetch category-specific leaderboard by scraping the website
 * URL pattern: https://polymarket.com/leaderboard/{category}/{period}/{metric}
 */
export async function fetchCategoryLeaderboard(
  category: LeaderboardCategory,
  period: 'all' | 'monthly' | 'weekly' = 'all',
  limit: number = 100
): Promise<LeaderboardEntry[]> {
  // Check cache
  const cacheKey = `${category}-${period}`;
  const cached = categoryCache.get(category);
  if (cached && Date.now() - cached.fetchedAt < CATEGORY_CACHE_TTL) {
    return cached.entries.slice(0, limit);
  }

  try {
    console.log(`[Leaderboard] Scraping ${category}/${period}/profit leaderboard...`);

    // Scrape the leaderboard page
    const url = `https://polymarket.com/leaderboard/${category}/${period}/profit`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();

    // Parse leaderboard data directly from HTML/embedded JSON
    const entries = parseLeaderboardFromHTML(html, category);

    if (entries.length === 0) {
      console.log(`[Leaderboard] No data found in page for ${category}`);
      return cached?.entries || [];
    }

    // Cache the result
    categoryCache.set(category, {
      entries,
      fetchedAt: Date.now(),
    });

    console.log(`[Leaderboard] Scraped ${entries.length} ${category} traders`);

    // Log top 3
    for (const entry of entries.slice(0, 3)) {
      const pnlStr = entry.pnl >= 1_000_000
        ? `$${(entry.pnl / 1_000_000).toFixed(1)}M`
        : `$${(entry.pnl / 1_000).toFixed(0)}K`;
      console.log(`  #${entry.rank} ${entry.displayName || entry.address.slice(0, 10)} - ${pnlStr}`);
    }

    return entries.slice(0, limit);

  } catch (error) {
    console.error(`[Leaderboard] Failed to scrape ${category} leaderboard:`, error);
    return cached?.entries || [];
  }
}

/**
 * Parse leaderboard entries from HTML/JSON embedded in page
 *
 * JSON format: {"rank":1,"proxyWallet":"0x...","name":"...","pseudonym":"...","amount":VOLUME,"pnl":PNL,"volume":VOLUME,...}
 * IMPORTANT: "amount" is actually VOLUME, not profit! Use "pnl" field for actual profit.
 */
function parseLeaderboardFromHTML(html: string, category: LeaderboardCategory): LeaderboardEntry[] {
  const entries: LeaderboardEntry[] = [];

  // Updated pattern to capture pnl and volume separately
  // Format: {"rank":N,"proxyWallet":"0x...","name":"...","pseudonym":"...","amount":VOL,"pnl":PNL,"volume":VOL,...}
  const jsonPattern = /\{"rank":(\d+),"proxyWallet":"(0x[a-fA-F0-9]{40})","name":"([^"]*)","pseudonym":"([^"]*)","amount":([0-9.-]+),"pnl":([0-9.-]+),"volume":([0-9.-]+)/g;

  let match;
  const seenAddresses = new Set<string>();

  while ((match = jsonPattern.exec(html)) !== null) {
    const rank = parseInt(match[1], 10);
    const address = match[2];
    const name = match[3];
    const pseudonym = match[4];
    // match[5] is "amount" which is actually volume (skip it)
    const pnl = parseFloat(match[6]) || 0;
    const volume = parseFloat(match[7]) || 0;

    // Skip duplicates (same address may appear in multiple query results)
    if (seenAddresses.has(address.toLowerCase())) continue;
    seenAddresses.add(address.toLowerCase());

    // Use the cleaner name if available
    const displayName = (name && !name.startsWith('0x') && name.length < 50) ? name :
                        (pseudonym && !pseudonym.startsWith('0x') && pseudonym.length < 50) ? pseudonym :
                        undefined;

    entries.push({
      rank,
      address,
      displayName,
      pnl,
      volume,
      positions: 0,
      category,
    });

    if (entries.length >= 100) break;
  }

  // Sort by pnl descending (highest profit first)
  entries.sort((a, b) => b.pnl - a.pnl);

  // Re-assign ranks based on pnl order
  entries.forEach((e, i) => e.rank = i + 1);

  return entries;
}

/**
 * Get top traders across all categories
 * Returns combined list from each category
 */
export async function fetchAllCategoryLeaderboards(topPerCategory: number = 10): Promise<Map<LeaderboardCategory, LeaderboardEntry[]>> {
  const categories: LeaderboardCategory[] = ['crypto', 'sports', 'politics', 'finance', 'climate'];
  const result = new Map<LeaderboardCategory, LeaderboardEntry[]>();

  // Fetch in parallel with rate limiting
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  for (const category of categories) {
    const entries = await fetchCategoryLeaderboard(category, 'all', topPerCategory);
    result.set(category, entries);
    await delay(100); // Rate limiting
  }

  return result;
}

/**
 * Get cached category leaderboard
 */
export function getCachedCategoryLeaderboard(category: LeaderboardCategory): LeaderboardEntry[] {
  return categoryCache.get(category)?.entries || [];
}

/**
 * Get all available categories
 */
export function getAvailableCategories(): LeaderboardCategory[] {
  return ['all', 'crypto', 'sports', 'politics', 'finance', 'economy', 'climate', 'culture', 'tech', 'world', 'geopolitics'];
}

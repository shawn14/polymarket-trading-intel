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

// Cache leaderboard data
let cachedLeaderboard: LeaderboardEntry[] = [];
let lastFetch = 0;
const CACHE_TTL = 1 * 60 * 60 * 1000; // 1 hour cache (refresh more frequently)

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
export async function fetchLeaderboard(limit: number = 50): Promise<LeaderboardEntry[]> {
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

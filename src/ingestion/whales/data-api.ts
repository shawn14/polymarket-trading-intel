/**
 * Polymarket Data API Client
 *
 * Fetches positions and activity data for traders via the data API.
 * This provides richer data than the CLOB WebSocket.
 */

// API endpoints
const DATA_API_BASE = 'https://data-api.polymarket.com';

// Rate limiting
const REQUEST_DELAY_MS = 100; // 10 req/sec safe limit

// Cache TTL
const POSITIONS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const ACTIVITY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Position from data API
export interface TraderPosition {
  conditionId: string;
  title: string;
  slug: string;
  outcome: 'Yes' | 'No';
  size: number; // shares
  avgPrice: number;
  curPrice: number;
  initialValue: number; // USDC spent
  currentValue: number; // USDC current worth
  cashPnl: number;
  percentPnl: number;
  realizedPnl: number;
}

// Activity/trade from data API
export interface TraderActivity {
  conditionId: string;
  title: string;
  slug: string;
  side: 'BUY' | 'SELL';
  outcome: 'Yes' | 'No';
  price: number;
  size: number; // shares
  usdcSize: number;
  createdAt: string; // ISO timestamp
  // User info from activity response
  name?: string;
  pseudonym?: string;
}

// User info extracted from activity
export interface TraderInfo {
  address: string;
  name?: string;
  pseudonym?: string;
}

// Cached data
interface CachedPositions {
  data: TraderPosition[];
  fetchedAt: number;
}

interface CachedActivity {
  data: TraderActivity[];
  userInfo?: TraderInfo;
  fetchedAt: number;
}

// In-memory cache
const positionsCache = new Map<string, CachedPositions>();
const activityCache = new Map<string, CachedActivity>();
const userInfoCache = new Map<string, TraderInfo>();

/**
 * Delay helper for rate limiting
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch positions for a trader
 */
export async function fetchPositions(address: string, limit = 200): Promise<TraderPosition[]> {
  const addrLower = address.toLowerCase();

  // Check cache
  const cached = positionsCache.get(addrLower);
  if (cached && Date.now() - cached.fetchedAt < POSITIONS_CACHE_TTL) {
    return cached.data;
  }

  try {
    await delay(REQUEST_DELAY_MS);

    const url = `${DATA_API_BASE}/positions?user=${addrLower}&limit=${limit}`;
    const response = await fetch(url);

    if (!response.ok) {
      console.error(`[DataAPI] Failed to fetch positions for ${addrLower}: ${response.status}`);
      return cached?.data || [];
    }

    const data = await response.json() as TraderPosition[];

    // Cache the result
    positionsCache.set(addrLower, {
      data,
      fetchedAt: Date.now(),
    });

    return data;

  } catch (error) {
    console.error(`[DataAPI] Error fetching positions for ${addrLower}:`, error);
    return cached?.data || [];
  }
}

/**
 * Fetch activity/trades for a trader
 */
export async function fetchActivity(address: string, limit = 500): Promise<TraderActivity[]> {
  const addrLower = address.toLowerCase();

  // Check cache
  const cached = activityCache.get(addrLower);
  if (cached && Date.now() - cached.fetchedAt < ACTIVITY_CACHE_TTL) {
    return cached.data;
  }

  try {
    await delay(REQUEST_DELAY_MS);

    const url = `${DATA_API_BASE}/activity?user=${addrLower}&limit=${limit}`;
    const response = await fetch(url);

    if (!response.ok) {
      console.error(`[DataAPI] Failed to fetch activity for ${addrLower}: ${response.status}`);
      return cached?.data || [];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawData = await response.json() as any[];

    // Extract user info from first activity record
    if (rawData.length > 0 && (rawData[0].name || rawData[0].pseudonym)) {
      const userInfo: TraderInfo = {
        address: addrLower,
        name: rawData[0].name || undefined,
        pseudonym: rawData[0].pseudonym || undefined,
      };
      userInfoCache.set(addrLower, userInfo);
    }

    // Map to our TraderActivity type
    const data: TraderActivity[] = rawData.map(item => ({
      conditionId: item.conditionId,
      title: item.title,
      slug: item.slug,
      side: item.side,
      outcome: item.outcome,
      price: item.price,
      size: item.size,
      usdcSize: item.usdcSize,
      createdAt: item.timestamp ? new Date(item.timestamp * 1000).toISOString() : '',
      name: item.name,
      pseudonym: item.pseudonym,
    }));

    // Cache the result
    activityCache.set(addrLower, {
      data,
      fetchedAt: Date.now(),
    });

    return data;

  } catch (error) {
    console.error(`[DataAPI] Error fetching activity for ${addrLower}:`, error);
    return cached?.data || [];
  }
}

/**
 * Get cached user info for an address
 */
export function getCachedUserInfo(address: string): TraderInfo | undefined {
  return userInfoCache.get(address.toLowerCase());
}

/**
 * Fetch both positions and activity for a trader
 */
export async function fetchTraderData(address: string): Promise<{
  positions: TraderPosition[];
  activity: TraderActivity[];
}> {
  const [positions, activity] = await Promise.all([
    fetchPositions(address),
    fetchActivity(address),
  ]);

  return { positions, activity };
}

/**
 * Clear cache for a specific address or all
 */
export function clearCache(address?: string): void {
  if (address) {
    const addrLower = address.toLowerCase();
    positionsCache.delete(addrLower);
    activityCache.delete(addrLower);
  } else {
    positionsCache.clear();
    activityCache.clear();
  }
}

/**
 * Get cache stats
 */
export function getCacheStats(): { positions: number; activity: number } {
  return {
    positions: positionsCache.size,
    activity: activityCache.size,
  };
}

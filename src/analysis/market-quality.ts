/**
 * Market Quality Assessment
 *
 * Filters markets by quality to prevent spam signals on thin/garbage markets.
 * Includes per-market cooldown to prevent signal spam.
 */

import type { MarketQuality } from '../ingestion/whales/types.js';

// Quality tier thresholds
const QUALITY_THRESHOLDS = {
  high: { minVolume: 100_000, maxSpread: 0.02, minTrades: 100 },
  medium: { minVolume: 25_000, maxSpread: 0.05, minTrades: 25 },
  low: { minVolume: 5_000, maxSpread: 0.10, minTrades: 10 },
  // Below low = garbage, no signals
};

// Signal cooldown per market (5 minutes)
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

// Market quality cache
const qualityCache: Map<string, { quality: MarketQuality; timestamp: number }> = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Signal cooldown tracker
const signalCooldown: Map<string, number> = new Map(); // marketId -> lastSignalTime

/**
 * Assess market quality
 */
export function assessMarketQuality(
  marketId: string,
  volume24h: number,
  spread: number,
  tradeCount24h: number
): MarketQuality {
  // Check cache
  const cached = qualityCache.get(marketId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.quality;
  }

  let qualityTier: MarketQuality['qualityTier'];

  if (
    volume24h >= QUALITY_THRESHOLDS.high.minVolume &&
    spread <= QUALITY_THRESHOLDS.high.maxSpread &&
    tradeCount24h >= QUALITY_THRESHOLDS.high.minTrades
  ) {
    qualityTier = 'high';
  } else if (
    volume24h >= QUALITY_THRESHOLDS.medium.minVolume &&
    spread <= QUALITY_THRESHOLDS.medium.maxSpread &&
    tradeCount24h >= QUALITY_THRESHOLDS.medium.minTrades
  ) {
    qualityTier = 'medium';
  } else if (
    volume24h >= QUALITY_THRESHOLDS.low.minVolume &&
    spread <= QUALITY_THRESHOLDS.low.maxSpread &&
    tradeCount24h >= QUALITY_THRESHOLDS.low.minTrades
  ) {
    qualityTier = 'low';
  } else {
    qualityTier = 'garbage';
  }

  const quality: MarketQuality = {
    marketId,
    volume24h,
    spread,
    tradeCount24h,
    qualityTier,
  };

  // Cache result
  qualityCache.set(marketId, { quality, timestamp: Date.now() });

  return quality;
}

/**
 * Check if a signal can fire for this market (cooldown check)
 */
export function canFireSignal(marketId: string, cooldownMs: number = DEFAULT_COOLDOWN_MS): boolean {
  const lastSignal = signalCooldown.get(marketId) || 0;
  return Date.now() - lastSignal >= cooldownMs;
}

/**
 * Record that a signal was fired for this market
 */
export function recordSignal(marketId: string): void {
  signalCooldown.set(marketId, Date.now());
}

/**
 * Check if market passes minimum quality for signals
 */
export function passesQualityCheck(quality: MarketQuality): boolean {
  return quality.qualityTier !== 'garbage';
}

/**
 * Check if market passes quality AND cooldown
 */
export function canEmitSignal(
  marketId: string,
  volume24h: number,
  spread: number,
  tradeCount24h: number,
  cooldownMs: number = DEFAULT_COOLDOWN_MS
): { allowed: boolean; reason?: string; quality: MarketQuality } {
  const quality = assessMarketQuality(marketId, volume24h, spread, tradeCount24h);

  if (!passesQualityCheck(quality)) {
    return {
      allowed: false,
      reason: `Market quality too low (${quality.qualityTier})`,
      quality,
    };
  }

  if (!canFireSignal(marketId, cooldownMs)) {
    return {
      allowed: false,
      reason: 'Signal cooldown active',
      quality,
    };
  }

  return { allowed: true, quality };
}

/**
 * Get quality tier label with color hint
 */
export function getQualityLabel(tier: MarketQuality['qualityTier']): { label: string; color: string } {
  switch (tier) {
    case 'high':
      return { label: 'HIGH LIQ', color: 'green' };
    case 'medium':
      return { label: 'MED LIQ', color: 'yellow' };
    case 'low':
      return { label: 'LOW LIQ', color: 'orange' };
    case 'garbage':
      return { label: 'ILLIQUID', color: 'red' };
  }
}

/**
 * Get minimum whale size for a market based on quality
 */
export function getMinWhaleSize(quality: MarketQuality['qualityTier']): number {
  switch (quality) {
    case 'high':
      return 20_000;  // $20k minimum for high liquidity
    case 'medium':
      return 10_000;  // $10k for medium
    case 'low':
      return 5_000;   // $5k for low
    case 'garbage':
      return Infinity; // No signals on garbage markets
  }
}

/**
 * Estimate market impact from a trade
 */
export function estimateMarketImpact(
  tradeSize: number,
  volume24h: number,
  spread: number
): { impactPct: number; severity: 'low' | 'medium' | 'high' } {
  const volumeRatio = tradeSize / volume24h;

  // Base impact from spread
  let impactPct = spread / 2;

  // Add volume-based impact
  if (volumeRatio > 0.1) {
    impactPct += 0.05; // Very large trade
  } else if (volumeRatio > 0.01) {
    impactPct += 0.02; // Large trade
  } else if (volumeRatio > 0.001) {
    impactPct += 0.01; // Medium trade
  }

  let severity: 'low' | 'medium' | 'high';
  if (impactPct < 0.02) {
    severity = 'low';
  } else if (impactPct < 0.05) {
    severity = 'medium';
  } else {
    severity = 'high';
  }

  return { impactPct, severity };
}

/**
 * Clear caches (for testing)
 */
export function clearCaches(): void {
  qualityCache.clear();
  signalCooldown.clear();
}

/**
 * Get quality thresholds (for documentation/debugging)
 */
export function getQualityThresholds() {
  return QUALITY_THRESHOLDS;
}

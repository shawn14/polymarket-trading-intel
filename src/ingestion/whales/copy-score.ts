/**
 * Copy Suitability Scoring
 *
 * Calculates how suitable a whale is for copying.
 * Higher score = easier to profitably copy.
 */

import type { WalletStats, CopySuitability } from './types.js';

// Minimum score to show COPY button
export const COPY_THRESHOLD = 60;

// Score weights and thresholds
const HOLD_TIME_BONUS_LONG = 15;    // > 24h
const HOLD_TIME_BONUS_MEDIUM = 8;   // > 6h
const HOLD_TIME_PENALTY_SHORT = -20; // < 1h (scalpers)

const LIQUIDITY_BONUS_HIGH = 10;    // avg market volume > $100k
const LIQUIDITY_PENALTY_LOW = -15;  // avg market volume < $10k

const CONSISTENCY_BONUS = 10;       // low PnL volatility
const CONSISTENCY_PENALTY = -10;    // high PnL volatility

const TAKER_BONUS = 5;              // taker-heavy (visible orders)
const MAKER_PENALTY = -10;          // maker-heavy (harder to copy)

const WIN_RATE_BONUS = 10;          // > 55% win rate
const WIN_RATE_PENALTY = -5;        // < 45% win rate

const EARLY_ENTRY_BONUS = 15;       // consistently early
const EARLY_ENTRY_PENALTY = -10;    // consistently late

/**
 * Calculate copy suitability score for a wallet
 */
export function calculateCopySuitability(stats: WalletStats): CopySuitability {
  let score = 50; // Baseline
  const reasoning: string[] = [];

  // 1. Hold time (longer = easier to copy)
  if (stats.avgHoldTimeHours > 24) {
    score += HOLD_TIME_BONUS_LONG;
    reasoning.push('Long holding period (>24h) - easy to copy');
  } else if (stats.avgHoldTimeHours > 6) {
    score += HOLD_TIME_BONUS_MEDIUM;
    reasoning.push('Medium holding period (6-24h)');
  } else if (stats.avgHoldTimeHours < 1) {
    score += HOLD_TIME_PENALTY_SHORT;
    reasoning.push('Scalper (<1h holds) - very difficult to copy');
  }

  // 2. Liquidity preference (trades liquid markets = lower slippage for copier)
  let liquidityPreference: 'high' | 'medium' | 'low' = 'medium';
  if (stats.avgMarketVolume > 100_000) {
    score += LIQUIDITY_BONUS_HIGH;
    liquidityPreference = 'high';
    reasoning.push('Trades liquid markets - low slippage risk');
  } else if (stats.avgMarketVolume < 10_000) {
    score += LIQUIDITY_PENALTY_LOW;
    liquidityPreference = 'low';
    reasoning.push('Trades illiquid markets - high slippage risk');
  }

  // 3. Consistency (low PnL volatility = predictable)
  if (stats.pnlVolatility < 0.2) {
    score += CONSISTENCY_BONUS;
    reasoning.push('Consistent returns');
  } else if (stats.pnlVolatility > 0.5) {
    score += CONSISTENCY_PENALTY;
    reasoning.push('High variance returns');
  }

  // 4. Maker ratio (taker = visible orders, easier to copy)
  if (stats.makerRatio < 0.3) {
    score += TAKER_BONUS;
    reasoning.push('Taker-heavy - orders visible on tape');
  } else if (stats.makerRatio > 0.7) {
    score += MAKER_PENALTY;
    reasoning.push('Maker-heavy - uses limit orders, harder to copy');
  }

  // 5. Win rate
  if (stats.winRate > 0.55) {
    score += WIN_RATE_BONUS;
    reasoning.push('High win rate (>55%)');
  } else if (stats.winRate < 0.45) {
    score += WIN_RATE_PENALTY;
    reasoning.push('Low win rate (<45%)');
  }

  // 6. Early entry score
  if (stats.earlyEntryScore > 70) {
    score += EARLY_ENTRY_BONUS;
    reasoning.push('Consistently enters early on moves');
  } else if (stats.earlyEntryScore < 30) {
    score += EARLY_ENTRY_PENALTY;
    reasoning.push('Often enters late - may be chasing');
  }

  // Clamp to 0-100
  score = Math.max(0, Math.min(100, score));

  // Determine slippage risk
  let slippageRisk: 'low' | 'medium' | 'high' = 'medium';
  if (liquidityPreference === 'high' && stats.avgHoldTimeHours > 6) {
    slippageRisk = 'low';
  } else if (liquidityPreference === 'low' || stats.avgHoldTimeHours < 1) {
    slippageRisk = 'high';
  }

  return {
    wallet: stats.address,
    score,
    avgHoldTimeHours: stats.avgHoldTimeHours,
    liquidityPreference,
    consistency: stats.pnlVolatility,
    makerRatio: stats.makerRatio,
    slippageRisk,
    reasoning,
  };
}

/**
 * Check if a whale is suitable for copying
 */
export function isCopyable(copySuitability: number): boolean {
  return copySuitability >= COPY_THRESHOLD;
}

/**
 * Get copy recommendation text
 */
export function getCopyRecommendation(score: number): string {
  if (score >= 80) {
    return 'Excellent copy target - low risk, long holds, liquid markets';
  } else if (score >= 60) {
    return 'Good copy target - reasonable risk/reward';
  } else if (score >= 40) {
    return 'Risky to copy - consider WATCH instead';
  } else {
    return 'Not recommended to copy - scalper or illiquid markets';
  }
}

/**
 * Get slippage estimate for copying this whale
 */
export function estimateSlippage(
  tradeSize: number,
  marketVolume24h: number,
  spread: number
): { slippagePct: number; recommendation: string } {
  // Rough estimate: slippage scales with size relative to volume
  const volumeRatio = tradeSize / marketVolume24h;

  let slippagePct = spread / 2; // At minimum, expect half spread

  // Add market impact estimate
  if (volumeRatio > 0.1) {
    // Very large trade
    slippagePct += 0.05;
  } else if (volumeRatio > 0.01) {
    // Large trade
    slippagePct += 0.02;
  } else if (volumeRatio > 0.001) {
    // Medium trade
    slippagePct += 0.01;
  }

  let recommendation: string;
  if (slippagePct < 0.01) {
    recommendation = 'Low slippage expected';
  } else if (slippagePct < 0.03) {
    recommendation = 'Moderate slippage expected';
  } else {
    recommendation = 'High slippage risk - consider smaller size';
  }

  return { slippagePct, recommendation };
}

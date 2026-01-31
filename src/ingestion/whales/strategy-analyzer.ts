/**
 * Strategy Analyzer
 *
 * Analyzes trader positions and activity to classify their trading strategies.
 * Identifies patterns like premium sellers, scalpers, directional traders, etc.
 */

import type { TraderPosition, TraderActivity } from './data-api.js';

// Market type classification
export type CryptoMarketType = 'crypto_dip' | 'crypto_reach' | 'crypto_daily' | 'crypto_15m' | 'crypto_other';
export type MarketType = CryptoMarketType | 'sports' | 'politics' | 'economics' | 'weather' | 'entertainment' | 'other';

// Strategy types
export type StrategyType =
  | 'crypto_premium_seller'  // Sells OTM crypto options (dip/reach NO)
  | 'crypto_directional'     // Mixed crypto YES/NO
  | 'crypto_scalper'         // 15m crypto markets
  | 'sports_bettor'          // Sports markets
  | 'political_trader'       // Political markets
  | 'weather_specialist'     // Weather markets
  | 'diversified'            // No single category >40%
  | 'unknown';

// Directional bias
export type DirectionalBias = 'bullish' | 'bearish' | 'neutral';

// Market focus breakdown
export interface MarketFocus {
  type: MarketType;
  count: number;
  pnl: number;
  volume: number;
  winRate: number;
}

// Full strategy profile for a trader
export interface StrategyProfile {
  address: string;
  username?: string;
  pnl: number;
  volume: number;

  // Strategy classification
  strategyType: StrategyType;
  strategyConfidence: 'high' | 'medium' | 'low';

  // Market breakdown
  marketFocus: MarketFocus[];
  primaryMarket: MarketType;

  // Trading metrics
  winRate: number;
  avgPositionSize: number;
  directionalBias: DirectionalBias;
  concentration: number; // % in top 5 positions

  // Position stats
  totalPositions: number;
  openPositions: number;
  yesPositions: number;
  noPositions: number;

  // Crypto-specific (if applicable)
  cryptoSubtypes?: {
    dip: number;
    reach: number;
    daily: number;
    fifteenMin: number;
    other: number;
  };

  // Analysis timestamp
  analyzedAt: number;
}

/**
 * Classify a market title into a market type
 */
export function classifyMarket(title: string): MarketType {
  const t = title.toLowerCase();

  // Crypto markets - check first as they're most specific
  const cryptoKeywords = ['bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'xrp', 'doge', 'crypto'];
  const isCrypto = cryptoKeywords.some(k => t.includes(k));

  if (isCrypto) {
    if (t.includes('dip to') || t.includes('fall to') || t.includes('drop to')) {
      return 'crypto_dip';
    }
    if (t.includes('reach') || t.includes('hit') || t.includes('above') && t.includes('by')) {
      return 'crypto_reach';
    }
    if (t.includes('above') || t.includes('below') || t.includes('greater than') || t.includes('less than')) {
      if (t.includes('february') || t.includes('january') || t.includes('march') || t.includes('on 20')) {
        return 'crypto_daily';
      }
    }
    if (t.includes('up or down') || t.includes('15 min') || t.includes('15m') || t.includes(':') && t.includes('am') || t.includes(':') && t.includes('pm')) {
      return 'crypto_15m';
    }
    return 'crypto_other';
  }

  // Sports markets
  const sportsKeywords = ['nba', 'nfl', 'nhl', 'mlb', 'ufc', 'mma', 'pga', 'atp', 'wta',
    'spread', 'o/u', 'over/under', 'moneyline', 'vs.', 'vs ', 'game', 'match',
    'lakers', 'celtics', 'warriors', 'chiefs', 'eagles', 'yankees', 'dodgers',
    'points', 'rebounds', 'assists', 'touchdowns', 'goals', 'win on 202'];
  if (sportsKeywords.some(k => t.includes(k))) {
    return 'sports';
  }

  // Politics markets
  const politicsKeywords = ['trump', 'biden', 'harris', 'desantis', 'republican', 'democrat',
    'election', 'senate', 'house', 'congress', 'president', 'governor', 'nominee',
    'primary', 'vote', 'cabinet', 'impeach'];
  if (politicsKeywords.some(k => t.includes(k))) {
    return 'politics';
  }

  // Economics/Fed markets
  const econKeywords = ['fed', 'fomc', 'interest rate', 'inflation', 'cpi', 'gdp',
    'recession', 'treasury', 'yield', 'employment', 'jobs'];
  if (econKeywords.some(k => t.includes(k))) {
    return 'economics';
  }

  // Weather markets
  const weatherKeywords = ['hurricane', 'storm', 'tropical', 'tornado', 'earthquake',
    'temperature', 'weather', 'nhc', 'landfall'];
  if (weatherKeywords.some(k => t.includes(k))) {
    return 'weather';
  }

  // Entertainment markets
  const entertainmentKeywords = ['oscar', 'grammy', 'emmy', 'golden globe', 'movie', 'film',
    'box office', 'netflix', 'music', 'album', 'billboard', 'celebrity', 'tv show'];
  if (entertainmentKeywords.some(k => t.includes(k))) {
    return 'entertainment';
  }

  return 'other';
}

/**
 * Analyze a trader's positions and activity to build strategy profile
 */
export function analyzeStrategy(
  address: string,
  positions: TraderPosition[],
  activity: TraderActivity[],
  username?: string,
  leaderboardPnl?: number
): StrategyProfile {
  // Group positions by market type
  const marketGroups = new Map<MarketType, TraderPosition[]>();

  for (const pos of positions) {
    const marketType = classifyMarket(pos.title);
    const existing = marketGroups.get(marketType) || [];
    existing.push(pos);
    marketGroups.set(marketType, existing);
  }

  // Calculate market focus breakdown
  const marketFocus: MarketFocus[] = [];
  let totalVolume = 0;
  let totalPnl = 0;
  let totalWins = 0;
  let totalPositions = 0;

  for (const [type, positionsInType] of marketGroups) {
    const count = positionsInType.length;
    const pnl = positionsInType.reduce((sum, p) => sum + p.cashPnl, 0);
    const volume = positionsInType.reduce((sum, p) => sum + p.initialValue, 0);
    const wins = positionsInType.filter(p => p.cashPnl > 0).length;
    const winRate = count > 0 ? (wins / count) * 100 : 0;

    marketFocus.push({ type, count, pnl, volume, winRate });

    totalVolume += volume;
    totalPnl += pnl;
    totalWins += wins;
    totalPositions += count;
  }

  // Sort by volume (primary market)
  marketFocus.sort((a, b) => b.volume - a.volume);
  const primaryMarket = marketFocus[0]?.type || 'other';

  // Calculate overall metrics
  const winRate = totalPositions > 0 ? (totalWins / totalPositions) * 100 : 0;
  const avgPositionSize = totalPositions > 0 ? totalVolume / totalPositions : 0;

  // Directional bias (YES vs NO)
  const yesPositions = positions.filter(p => p.outcome === 'Yes').length;
  const noPositions = positions.filter(p => p.outcome === 'No').length;
  let directionalBias: DirectionalBias = 'neutral';
  if (totalPositions > 0) {
    const yesRatio = yesPositions / totalPositions;
    if (yesRatio > 0.65) directionalBias = 'bullish';
    else if (yesRatio < 0.35) directionalBias = 'bearish';
  }

  // Concentration (top 5 positions as % of total)
  const sortedByValue = [...positions].sort((a, b) => b.currentValue - a.currentValue);
  const top5Value = sortedByValue.slice(0, 5).reduce((sum, p) => sum + p.currentValue, 0);
  const totalValue = positions.reduce((sum, p) => sum + p.currentValue, 0);
  const concentration = totalValue > 0 ? (top5Value / totalValue) * 100 : 0;

  // Crypto-specific subtypes
  let cryptoSubtypes: StrategyProfile['cryptoSubtypes'] | undefined;
  const cryptoTypes: CryptoMarketType[] = ['crypto_dip', 'crypto_reach', 'crypto_daily', 'crypto_15m', 'crypto_other'];
  const hasCrypto = cryptoTypes.some(t => marketGroups.has(t));

  if (hasCrypto) {
    cryptoSubtypes = {
      dip: marketGroups.get('crypto_dip')?.length || 0,
      reach: marketGroups.get('crypto_reach')?.length || 0,
      daily: marketGroups.get('crypto_daily')?.length || 0,
      fifteenMin: marketGroups.get('crypto_15m')?.length || 0,
      other: marketGroups.get('crypto_other')?.length || 0,
    };
  }

  // Classify strategy type
  const { strategyType, strategyConfidence } = classifyStrategyType(
    marketFocus,
    directionalBias,
    cryptoSubtypes,
    totalPositions
  );

  // Use leaderboard PnL if provided, otherwise use calculated
  const finalPnl = leaderboardPnl ?? totalPnl;

  return {
    address,
    username,
    pnl: finalPnl,
    volume: totalVolume,
    strategyType,
    strategyConfidence,
    marketFocus,
    primaryMarket,
    winRate,
    avgPositionSize,
    directionalBias,
    concentration,
    totalPositions,
    openPositions: positions.filter(p => Math.abs(p.size) > 0).length,
    yesPositions,
    noPositions,
    cryptoSubtypes,
    analyzedAt: Date.now(),
  };
}

/**
 * Classify strategy type based on market focus and trading patterns
 */
function classifyStrategyType(
  marketFocus: MarketFocus[],
  directionalBias: DirectionalBias,
  cryptoSubtypes: StrategyProfile['cryptoSubtypes'] | undefined,
  totalPositions: number
): { strategyType: StrategyType; strategyConfidence: 'high' | 'medium' | 'low' } {
  if (totalPositions < 5) {
    return { strategyType: 'unknown', strategyConfidence: 'low' };
  }

  // Calculate percentages by category
  const totalCount = marketFocus.reduce((sum, mf) => sum + mf.count, 0);
  const getCategoryPercent = (types: MarketType[]): number => {
    const count = marketFocus
      .filter(mf => types.includes(mf.type))
      .reduce((sum, mf) => sum + mf.count, 0);
    return totalCount > 0 ? (count / totalCount) * 100 : 0;
  };

  const cryptoPercent = getCategoryPercent(['crypto_dip', 'crypto_reach', 'crypto_daily', 'crypto_15m', 'crypto_other']);
  const sportsPercent = getCategoryPercent(['sports']);
  const politicsPercent = getCategoryPercent(['politics']);
  const weatherPercent = getCategoryPercent(['weather']);

  // Check for crypto premium seller (sells dip/reach NO positions)
  if (cryptoPercent > 50 && cryptoSubtypes) {
    const dipReachCount = cryptoSubtypes.dip + cryptoSubtypes.reach;
    const totalCrypto = cryptoSubtypes.dip + cryptoSubtypes.reach + cryptoSubtypes.daily + cryptoSubtypes.fifteenMin + cryptoSubtypes.other;

    if (totalCrypto > 0 && (dipReachCount / totalCrypto) > 0.5 && directionalBias === 'bearish') {
      return {
        strategyType: 'crypto_premium_seller',
        strategyConfidence: totalPositions > 20 ? 'high' : 'medium',
      };
    }

    // Check for crypto scalper (15m markets)
    if (totalCrypto > 0 && (cryptoSubtypes.fifteenMin / totalCrypto) > 0.5) {
      return {
        strategyType: 'crypto_scalper',
        strategyConfidence: totalPositions > 20 ? 'high' : 'medium',
      };
    }

    // General crypto directional
    return {
      strategyType: 'crypto_directional',
      strategyConfidence: totalPositions > 20 ? 'high' : 'medium',
    };
  }

  // Sports bettor
  if (sportsPercent > 50) {
    return {
      strategyType: 'sports_bettor',
      strategyConfidence: totalPositions > 20 ? 'high' : 'medium',
    };
  }

  // Political trader
  if (politicsPercent > 50) {
    return {
      strategyType: 'political_trader',
      strategyConfidence: totalPositions > 20 ? 'high' : 'medium',
    };
  }

  // Weather specialist
  if (weatherPercent > 40) {
    return {
      strategyType: 'weather_specialist',
      strategyConfidence: totalPositions > 10 ? 'high' : 'medium',
    };
  }

  // Diversified (no single category > 40%)
  const maxPercent = Math.max(cryptoPercent, sportsPercent, politicsPercent, weatherPercent);
  if (maxPercent < 40) {
    return {
      strategyType: 'diversified',
      strategyConfidence: totalPositions > 20 ? 'high' : 'medium',
    };
  }

  return { strategyType: 'unknown', strategyConfidence: 'low' };
}

/**
 * Generate strategy comparison report
 */
export function generateStrategyReport(profiles: StrategyProfile[]): string {
  const lines: string[] = [];

  lines.push('STRATEGY RANKINGS BY PNL');
  lines.push('========================');
  lines.push('');

  // Group by strategy type
  const byStrategy = new Map<StrategyType, StrategyProfile[]>();
  for (const p of profiles) {
    const existing = byStrategy.get(p.strategyType) || [];
    existing.push(p);
    byStrategy.set(p.strategyType, existing);
  }

  // Sort and display
  const sortedStrategies = [...byStrategy.entries()]
    .map(([type, profs]) => ({
      type,
      count: profs.length,
      totalPnl: profs.reduce((sum, p) => sum + p.pnl, 0),
      avgWinRate: profs.reduce((sum, p) => sum + p.winRate, 0) / profs.length,
    }))
    .sort((a, b) => b.totalPnl - a.totalPnl);

  for (let i = 0; i < sortedStrategies.length; i++) {
    const s = sortedStrategies[i];
    const pnlStr = s.totalPnl >= 1000000
      ? `$${(s.totalPnl / 1000000).toFixed(1)}M`
      : `$${(s.totalPnl / 1000).toFixed(0)}K`;
    lines.push(`${i + 1}. ${s.type}: ${s.count} traders, ${pnlStr} total PnL, ${s.avgWinRate.toFixed(0)}% avg win rate`);
  }

  lines.push('');
  lines.push('TOP TRADERS BY STRATEGY');
  lines.push('=======================');
  lines.push('');

  // Show top 3 per strategy
  for (const [type, profs] of byStrategy) {
    if (type === 'unknown') continue;

    lines.push(`--- ${type.toUpperCase()} ---`);
    const sorted = profs.sort((a, b) => b.pnl - a.pnl).slice(0, 3);

    for (const p of sorted) {
      const pnlStr = p.pnl >= 1000000
        ? `$${(p.pnl / 1000000).toFixed(2)}M`
        : `$${(p.pnl / 1000).toFixed(0)}K`;
      const avgPosStr = p.avgPositionSize >= 1000
        ? `$${(p.avgPositionSize / 1000).toFixed(0)}K`
        : `$${p.avgPositionSize.toFixed(0)}`;

      lines.push(`  ${p.username || p.address.slice(0, 10)}: ${pnlStr} PnL`);
      lines.push(`    - ${p.winRate.toFixed(0)}% win rate, ${avgPosStr} avg position`);
      lines.push(`    - ${p.directionalBias} bias, ${p.totalPositions} positions`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Get strategy type display label
 */
export function getStrategyLabel(type: StrategyType): string {
  const labels: Record<StrategyType, string> = {
    crypto_premium_seller: 'Crypto Premium Seller',
    crypto_directional: 'Crypto Directional',
    crypto_scalper: 'Crypto Scalper',
    sports_bettor: 'Sports Bettor',
    political_trader: 'Political Trader',
    weather_specialist: 'Weather Specialist',
    diversified: 'Diversified',
    unknown: 'Unknown',
  };
  return labels[type];
}

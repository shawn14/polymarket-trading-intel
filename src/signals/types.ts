/**
 * Signal Detection Types
 */

export type SignalType =
  | 'price_spike'
  | 'volume_spike'
  | 'spread_compression'
  | 'aggressive_sweep'
  | 'depth_pull'
  | 'unusual_activity';

export type SignalStrength = 'low' | 'medium' | 'high' | 'very_high';

export interface Signal {
  id: string;
  type: SignalType;
  strength: SignalStrength;
  assetId: string;
  market: string;
  timestamp: number;
  data: SignalData;
  description: string;
}

export interface PriceSpikeData {
  type: 'price_spike';
  previousPrice: number;
  currentPrice: number;
  changePercent: number;
  direction: 'up' | 'down';
  timeWindowMs: number;
}

export interface VolumeSpikeData {
  type: 'volume_spike';
  currentVolume: number;
  baselineVolume: number;
  multiplier: number;
  timeWindowMs: number;
}

export interface SpreadCompressionData {
  type: 'spread_compression';
  previousSpread: number;
  currentSpread: number;
  compressionPercent: number;
  side: 'bid' | 'ask' | 'both';
}

export interface AggressiveSweepData {
  type: 'aggressive_sweep';
  side: 'BUY' | 'SELL';
  totalSize: number;
  tradeCount: number;
  priceImpact: number;
  timeWindowMs: number;
}

export interface DepthPullData {
  type: 'depth_pull';
  side: 'bid' | 'ask';
  previousDepth: number;
  currentDepth: number;
  pullPercent: number;
}

export interface UnusualActivityData {
  type: 'unusual_activity';
  metric: string;
  value: number;
  baseline: number;
  deviation: number;
}

export type SignalData =
  | PriceSpikeData
  | VolumeSpikeData
  | SpreadCompressionData
  | AggressiveSweepData
  | DepthPullData
  | UnusualActivityData;

// Configuration for detection thresholds
export interface DetectorConfig {
  // Price spike detection
  priceSpike: {
    thresholdPercent: number; // e.g., 5 = 5% move triggers signal
    timeWindowMs: number; // e.g., 300000 = 5 minutes
    minStrengthPercent: Record<SignalStrength, number>;
  };

  // Volume spike detection
  volumeSpike: {
    baselineWindowMs: number; // e.g., 3600000 = 1 hour baseline
    multiplierThreshold: number; // e.g., 3 = 3x baseline triggers signal
    minStrengthMultiplier: Record<SignalStrength, number>;
  };

  // Spread compression detection
  spreadCompression: {
    thresholdPercent: number; // e.g., 50 = 50% compression triggers signal
    minSpread: number; // ignore if spread already tiny
  };

  // Aggressive sweep detection
  aggressiveSweep: {
    timeWindowMs: number; // e.g., 60000 = 1 minute
    minTradeCount: number; // e.g., 3 trades
    minTotalSize: number; // e.g., 100 shares
    minPriceImpact: number; // e.g., 0.02 = 2%
  };

  // Depth pull detection
  depthPull: {
    thresholdPercent: number; // e.g., 50 = 50% depth removed
    minDepth: number; // ignore if depth already thin
  };
}

// Market state tracking
export interface MarketState {
  assetId: string;
  market: string;

  // Price history
  priceHistory: Array<{ price: number; timestamp: number }>;
  currentPrice: number;

  // Volume tracking
  volumeHistory: Array<{ volume: number; timestamp: number }>;
  recentVolume: number;

  // Order book state
  bestBid: number;
  bestAsk: number;
  spread: number;
  bidDepth: number;
  askDepth: number;

  // Trade tracking
  recentTrades: Array<{
    price: number;
    size: number;
    side: 'BUY' | 'SELL';
    timestamp: number;
  }>;

  // Timestamps
  firstSeen: number;
  lastUpdate: number;
}

export const DEFAULT_CONFIG: DetectorConfig = {
  priceSpike: {
    thresholdPercent: 3,
    timeWindowMs: 5 * 60 * 1000, // 5 minutes
    minStrengthPercent: {
      low: 3,
      medium: 5,
      high: 10,
      very_high: 20,
    },
  },
  volumeSpike: {
    baselineWindowMs: 60 * 60 * 1000, // 1 hour
    multiplierThreshold: 3,
    minStrengthMultiplier: {
      low: 3,
      medium: 5,
      high: 10,
      very_high: 20,
    },
  },
  spreadCompression: {
    thresholdPercent: 40,
    minSpread: 0.01,
  },
  aggressiveSweep: {
    timeWindowMs: 60 * 1000, // 1 minute
    minTradeCount: 3,
    minTotalSize: 50,
    minPriceImpact: 0.02,
  },
  depthPull: {
    thresholdPercent: 50,
    minDepth: 100,
  },
};

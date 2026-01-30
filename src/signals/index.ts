export { SignalDetector } from './detector.js';
export type { SignalDetectorEvents } from './detector.js';
export type {
  Signal,
  SignalType,
  SignalStrength,
  SignalData,
  PriceSpikeData,
  VolumeSpikeData,
  SpreadCompressionData,
  AggressiveSweepData,
  DepthPullData,
  UnusualActivityData,
  MarketState,
  DetectorConfig,
} from './types.js';
export { DEFAULT_CONFIG } from './types.js';

// Truth-Market Linker
export { TruthMarketLinker } from './truth-change/index.js';
export type { TruthMarketLinkerEvents } from './truth-change/index.js';
export type {
  TruthSourceType,
  MarketCategory,
  TruthMap,
  LinkedAlert,
  TruthSourceEvent,
  CongressEvent,
  AffectedMarket,
  TrackedMarket,
} from './truth-change/index.js';
export {
  SHUTDOWN_TRUTH_MAP,
  LEGISLATION_TRUTH_MAP,
  FED_RATE_TRUTH_MAP,
  HURRICANE_TRUTH_MAP,
} from './truth-change/index.js';

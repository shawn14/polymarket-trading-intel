/**
 * Federal Reserve / FOMC Types
 */

// Fed event types
export type FedEventType =
  | 'fomc_statement'
  | 'fomc_minutes'
  | 'rate_decision'
  | 'speech'
  | 'testimony'
  | 'beige_book'
  | 'economic_projections';

// Rate decision outcomes
export type RateDecision = 'hike' | 'cut' | 'hold';

// Fed RSS item from press_monetary.xml
export interface FedRSSItem {
  title: string;
  link: string;
  guid: string;
  pubDate: string;
  description: string;
  'dc:date'?: string;
}

// Parsed Fed event
export interface FedEvent {
  id: string;
  type: FedEventType;
  timestamp: number;
  title: string;
  description: string;
  url: string;

  // Rate decision details (if applicable)
  rateDecision?: RateDecision;
  rateChange?: number; // in basis points (e.g., 25, -25, 0)
  newRate?: {
    lower: number;
    upper: number;
  };

  // Content analysis
  sentiment?: 'hawkish' | 'dovish' | 'neutral';
  keyPhrases?: string[];

  // Significance
  significance: 'low' | 'medium' | 'high' | 'critical';
}

// FOMC meeting schedule
export interface FOMCMeeting {
  date: string; // YYYY-MM-DD
  endDate?: string; // For two-day meetings
  isScheduled: boolean;
  hasProjections: boolean; // SEP meetings
  statementTime?: string; // Usually 2:00 PM ET
}

// FRED series data
export interface FREDSeries {
  id: string;
  title: string;
  frequency: string;
  units: string;
  lastUpdated: string;
}

export interface FREDObservation {
  date: string;
  value: string;
}

// Fed client configuration
export interface FedClientConfig {
  pollIntervalMs?: number;
  fredApiKey?: string; // Optional FRED API key
}

// Key Fed RSS feeds
export const FED_RSS_FEEDS = {
  monetary: 'https://www.federalreserve.gov/feeds/press_monetary.xml',
  all: 'https://www.federalreserve.gov/feeds/press_all.xml',
  speeches: 'https://www.federalreserve.gov/feeds/speeches.xml',
  testimony: 'https://www.federalreserve.gov/feeds/testimony.xml',
};

// FRED API base
export const FRED_API_BASE = 'https://api.stlouisfed.org/fred';

// Key FRED series for rate decisions
export const KEY_FRED_SERIES = {
  fedFundsRate: 'DFF', // Daily Fed Funds Rate
  fedFundsTarget: 'DFEDTARU', // Fed Funds Target Upper
  fedFundsTargetLower: 'DFEDTARL', // Fed Funds Target Lower
  inflation: 'CPIAUCSL', // CPI
  unemployment: 'UNRATE', // Unemployment Rate
  gdp: 'GDP', // GDP
};

// Keywords for detecting rate decisions
export const RATE_DECISION_KEYWORDS = {
  hike: [
    'raise',
    'increase',
    'higher',
    'tighten',
    'hiking',
  ],
  cut: [
    'lower',
    'reduce',
    'decrease',
    'cut',
    'ease',
    'easing',
  ],
  hold: [
    'maintain',
    'unchanged',
    'steady',
    'hold',
    'pause',
  ],
};

// Hawkish/Dovish signal words
export const SENTIMENT_KEYWORDS = {
  hawkish: [
    'inflation',
    'overheating',
    'tighten',
    'restrictive',
    'vigilant',
    'concerned about inflation',
    'price stability',
    'elevated inflation',
  ],
  dovish: [
    'support',
    'accommodate',
    'patient',
    'gradual',
    'data dependent',
    'labor market',
    'employment',
    'below target',
    'slowdown',
  ],
};

// 2024-2025 FOMC meeting dates (for reference)
export const FOMC_MEETINGS_2025 = [
  { date: '2025-01-28', endDate: '2025-01-29', hasProjections: false },
  { date: '2025-03-18', endDate: '2025-03-19', hasProjections: true },
  { date: '2025-05-06', endDate: '2025-05-07', hasProjections: false },
  { date: '2025-06-17', endDate: '2025-06-18', hasProjections: true },
  { date: '2025-07-29', endDate: '2025-07-30', hasProjections: false },
  { date: '2025-09-16', endDate: '2025-09-17', hasProjections: true },
  { date: '2025-11-05', endDate: '2025-11-06', hasProjections: false },
  { date: '2025-12-16', endDate: '2025-12-17', hasProjections: true },
];

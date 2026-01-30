/**
 * NWS Weather API Types
 */

// NWS Alert severity levels
export type AlertSeverity = 'Extreme' | 'Severe' | 'Moderate' | 'Minor' | 'Unknown';

// NWS Alert urgency levels
export type AlertUrgency = 'Immediate' | 'Expected' | 'Future' | 'Past' | 'Unknown';

// NWS Alert certainty levels
export type AlertCertainty = 'Observed' | 'Likely' | 'Possible' | 'Unlikely' | 'Unknown';

// Alert event types we care about
export const HIGH_IMPACT_EVENTS = [
  'Hurricane Warning',
  'Hurricane Watch',
  'Tropical Storm Warning',
  'Tropical Storm Watch',
  'Storm Surge Warning',
  'Storm Surge Watch',
  'Extreme Wind Warning',
  'Tornado Warning',
  'Tornado Watch',
  'Severe Thunderstorm Warning',
  'Flash Flood Warning',
  'Blizzard Warning',
  'Ice Storm Warning',
  'Winter Storm Warning',
  'Earthquake Warning',
  'Tsunami Warning',
  'Volcano Warning',
];

// NWS Alert from API
export interface NWSAlert {
  id: string;
  areaDesc: string;
  geocode: {
    SAME?: string[];
    UGC?: string[];
  };
  affectedZones: string[];
  references: Array<{
    identifier: string;
    sender: string;
    sent: string;
  }>;
  sent: string;
  effective: string;
  onset?: string;
  expires: string;
  ends?: string;
  status: 'Actual' | 'Exercise' | 'System' | 'Test' | 'Draft';
  messageType: 'Alert' | 'Update' | 'Cancel' | 'Ack' | 'Error';
  category: string;
  severity: AlertSeverity;
  certainty: AlertCertainty;
  urgency: AlertUrgency;
  event: string;
  sender: string;
  senderName: string;
  headline: string;
  description: string;
  instruction?: string;
  response: string;
  parameters: Record<string, string[]>;
}

// NWS Alerts API response
export interface NWSAlertsResponse {
  '@context': unknown;
  type: 'FeatureCollection';
  features: Array<{
    id: string;
    type: 'Feature';
    geometry: unknown;
    properties: NWSAlert;
  }>;
  title: string;
  updated: string;
}

// Tropical cyclone from NHC RSS
export interface TropicalCyclone {
  id: string;
  name: string;
  wallet: string; // e.g., AT1, EP2
  type: 'Hurricane' | 'Tropical Storm' | 'Tropical Depression' | 'Post-Tropical' | 'Subtropical';
  category?: number; // 1-5 for hurricanes
  movement: {
    direction: string;
    speed: number; // mph
  };
  location: {
    lat: number;
    lon: number;
  };
  maxWinds: number; // mph
  minPressure?: number; // mb
  advisory: {
    number: string;
    time: string;
    headline: string;
    url: string;
  };
  forecastTrack?: {
    hours: number;
    lat: number;
    lon: number;
    maxWinds: number;
    category?: number;
  }[];
}

// NHC RSS item
export interface NHCRSSItem {
  title: string;
  link: string;
  guid: string;
  pubDate: string;
  description: string;
}

// Processed weather event for our system
export interface WeatherEvent {
  id: string;
  type: 'alert' | 'tropical';
  timestamp: number;
  source: 'NWS' | 'NHC';

  // Alert details
  event: string;
  severity: AlertSeverity;
  urgency: AlertUrgency;
  certainty: AlertCertainty;

  // Location
  areas: string[];
  states: string[];

  // Content
  headline: string;
  description: string;
  instruction?: string;

  // Timing
  effective: string;
  expires: string;

  // For tropical systems
  cyclone?: TropicalCyclone;

  // Significance for our system
  significance: 'low' | 'medium' | 'high' | 'critical';
}

// Weather client configuration
export interface WeatherClientConfig {
  pollIntervalMs?: number;
  states?: string[]; // Filter by states
  includeMinor?: boolean; // Include minor severity
}

// State abbreviations for filtering
export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC', 'PR', 'VI', 'GU', 'AS', 'MP',
];

// Hurricane-prone states
export const HURRICANE_STATES = [
  'FL', 'TX', 'LA', 'NC', 'SC', 'GA', 'AL', 'MS', 'VA', 'MD',
  'DE', 'NJ', 'NY', 'CT', 'RI', 'MA', 'NH', 'ME', 'PR', 'VI',
];

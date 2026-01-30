/**
 * Playbook Types
 *
 * Market-specific logic modules that provide specialized analysis,
 * timing windows, and actionable insights for different market categories.
 */

// Playbook status for a specific market
export interface PlaybookStatus {
  category: PlaybookCategory;
  marketId: string;
  question: string;

  // Current state
  phase: PlaybookPhase;
  urgency: 'low' | 'medium' | 'high' | 'critical';

  // Timing
  nextKeyEvent?: KeyEvent;
  countdown?: Countdown;

  // Analysis
  signals: PlaybookSignal[];
  recommendation?: Recommendation;

  // Metadata
  lastUpdated: number;
}

export type PlaybookCategory =
  | 'shutdown'
  | 'hurricane'
  | 'fed_decision'
  | 'sports_player'
  | 'sports_outcome';

export type PlaybookPhase =
  | 'monitoring'      // Normal monitoring, no imminent event
  | 'approaching'     // Key event approaching (days away)
  | 'imminent'        // Key event imminent (hours away)
  | 'active'          // Event in progress
  | 'resolution'      // Event resolving, outcome becoming clear
  | 'settled';        // Market should be settling

// Key upcoming event
export interface KeyEvent {
  name: string;
  timestamp: number;
  description: string;
  impact: 'low' | 'medium' | 'high' | 'critical';
}

// Countdown to key event
export interface Countdown {
  eventName: string;
  targetTimestamp: number;
  daysRemaining: number;
  hoursRemaining: number;
  isOverdue: boolean;
}

// Signal from playbook analysis
export interface PlaybookSignal {
  type: string;
  description: string;
  strength: 'weak' | 'moderate' | 'strong';
  timestamp: number;
  data?: Record<string, unknown>;
}

// Trading recommendation
export interface Recommendation {
  action: 'watch' | 'consider_yes' | 'consider_no' | 'strong_yes' | 'strong_no' | 'avoid';
  confidence: number; // 0-1
  reasoning: string;
  caveats: string[];
}

// Playbook interface that all playbooks implement
export interface Playbook {
  category: PlaybookCategory;

  // Check if this playbook applies to a market
  matches(question: string, description: string): boolean;

  // Analyze current state for a market
  analyze(marketId: string, question: string, currentPrice: number): Promise<PlaybookStatus>;

  // Get key dates/events for this category
  getKeyDates(): KeyEvent[];
}

// Government shutdown specific types
export interface ShutdownState {
  currentFunding: 'full_year' | 'cr' | 'lapsed' | 'unknown';
  crExpiration?: Date;
  daysUntilExpiration?: number;
  appropriationsBillsEnacted: number;
  appropriationsBillsTotal: number;
  inShutdown: boolean;
}

// Hurricane specific types
export interface HurricaneState {
  activeSystems: ActiveStorm[];
  watchesWarnings: WatchWarning[];
  basinActivity: 'quiet' | 'active' | 'hyperactive';
}

export interface ActiveStorm {
  name: string;
  category: number | 'TD' | 'TS';
  windSpeed: number;
  pressure: number;
  movement: string;
  location: { lat: number; lon: number };
  forecastLandfall?: {
    location: string;
    timestamp: number;
    probability: number;
  };
}

export interface WatchWarning {
  type: 'Hurricane Watch' | 'Hurricane Warning' | 'Tropical Storm Watch' | 'Tropical Storm Warning';
  areas: string[];
  issuedAt: number;
  expiresAt: number;
}

// Fed decision specific types
export interface FedState {
  nextMeeting?: FOMCMeeting;
  currentRate: { lower: number; upper: number };
  marketExpectations: RateExpectation[];
  inBlackoutPeriod: boolean;
}

export interface FOMCMeeting {
  dates: [string, string]; // Two-day meeting
  announcementTime: number; // 2:00 PM ET typically
  hasSEP: boolean; // Summary of Economic Projections
  hasPressConference: boolean;
}

export interface RateExpectation {
  outcome: 'hike_50' | 'hike_25' | 'hold' | 'cut_25' | 'cut_50';
  probability: number;
}

// Sports specific types
export interface SportsGameState {
  league: string;
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  gameTime: number;
  status: 'scheduled' | 'pregame' | 'in_progress' | 'final' | 'postponed';

  // For player props
  playerStatus?: {
    name: string;
    status: string;
    inLineup: boolean;
  };

  // Timing windows
  injuryReportWindow: boolean;
  lineupConfirmed: boolean;
}

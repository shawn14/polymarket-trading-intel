/**
 * Sports Client Types
 *
 * Monitors official injury reports and lineup confirmations.
 * Key use case: Player prop markets, game outcome markets.
 */

// Supported leagues
export type SportsLeague = 'NFL' | 'NBA' | 'MLB' | 'NHL' | 'EPL' | 'MLS';

// Injury status designations
export type InjuryStatus =
  | 'out'           // Will not play
  | 'doubtful'      // Unlikely to play (25% chance)
  | 'questionable'  // Uncertain (50% chance)
  | 'probable'      // Likely to play (75% chance)
  | 'available'     // Cleared to play
  | 'day-to-day'    // Re-evaluated daily
  | 'ir'            // Injured reserve
  | 'pup'           // Physically unable to perform
  | 'suspended';    // League suspension

// Player injury report
export interface InjuryReport {
  id: string;
  league: SportsLeague;
  team: string;
  teamAbbr: string;
  player: string;
  position: string;
  status: InjuryStatus;
  previousStatus?: InjuryStatus;
  injury: string;           // "Knee", "Illness", "Rest", etc.
  gameDate?: string;        // ISO date of affected game
  opponent?: string;
  reportDate: string;       // When report was issued
  source: string;           // "official", "team", "reporter"
  isUpdate: boolean;        // Status changed from previous
}

// Sports event emitted by client
export interface SportsEvent {
  id: string;
  type: 'injury_update' | 'lineup_confirmed' | 'game_status' | 'trade';
  league: SportsLeague;
  timestamp: number;

  // For injury updates
  injury?: InjuryReport;

  // For lineup confirmations
  lineup?: LineupConfirmation;

  // For game status
  gameStatus?: GameStatus;

  // Significance
  significance: 'critical' | 'high' | 'medium' | 'low';

  // Human-readable
  headline: string;
  details: string;
}

// Confirmed lineup
export interface LineupConfirmation {
  league: SportsLeague;
  team: string;
  teamAbbr: string;
  gameDate: string;
  opponent: string;
  starters: PlayerInfo[];
  notables: {
    in: PlayerInfo[];   // Key players confirmed in
    out: PlayerInfo[];  // Key players confirmed out
  };
  source: string;
  confirmed: boolean;
}

// Basic player info
export interface PlayerInfo {
  name: string;
  position: string;
  number?: string;
}

// Game status update
export interface GameStatus {
  league: SportsLeague;
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  status: 'scheduled' | 'postponed' | 'delayed' | 'in_progress' | 'final' | 'cancelled';
  reason?: string;  // Weather, COVID, etc.
  newDate?: string; // If postponed
}

// Client configuration
export interface SportsClientConfig {
  leagues?: SportsLeague[];
  pollIntervalMs?: number;
  // Team filters (empty = all teams)
  nflTeams?: string[];
  nbaTeams?: string[];
  mlbTeams?: string[];
}

// ESPN API response types
export interface ESPNAthlete {
  id: string;
  displayName: string;
  position: {
    abbreviation: string;
  };
  team?: {
    displayName: string;
    abbreviation: string;
  };
  injuries?: ESPNInjury[];
}

export interface ESPNInjury {
  status: string;
  date: string;
  type: {
    description: string;
  };
  details?: {
    returnDate?: string;
  };
}

export interface ESPNTeam {
  id: string;
  displayName: string;
  abbreviation: string;
  athletes?: ESPNAthlete[];
}

// Known star players for priority detection
export const STAR_PLAYERS: Record<SportsLeague, string[]> = {
  NFL: [
    'Patrick Mahomes', 'Josh Allen', 'Lamar Jackson', 'Joe Burrow', 'Jalen Hurts',
    'Travis Kelce', 'Tyreek Hill', 'Justin Jefferson', 'Ja\'Marr Chase', 'CeeDee Lamb',
    'Derrick Henry', 'Saquon Barkley', 'Christian McCaffrey', 'Bijan Robinson',
    'Micah Parsons', 'T.J. Watt', 'Myles Garrett', 'Nick Bosa',
  ],
  NBA: [
    'LeBron James', 'Stephen Curry', 'Kevin Durant', 'Giannis Antetokounmpo',
    'Luka Doncic', 'Nikola Jokic', 'Joel Embiid', 'Jayson Tatum', 'Anthony Edwards',
    'Shai Gilgeous-Alexander', 'Ja Morant', 'Donovan Mitchell', 'Anthony Davis',
    'Devin Booker', 'Damian Lillard', 'Jimmy Butler', 'Kawhi Leonard', 'Paul George',
  ],
  MLB: [
    'Shohei Ohtani', 'Mike Trout', 'Mookie Betts', 'Ronald Acuña Jr.', 'Juan Soto',
    'Aaron Judge', 'Freddie Freeman', 'Corey Seager', 'Trea Turner', 'Manny Machado',
    'Gerrit Cole', 'Spencer Strider', 'Zack Wheeler', 'Corbin Burnes',
  ],
  NHL: [
    'Connor McDavid', 'Nathan MacKinnon', 'Auston Matthews', 'Leon Draisaitl',
    'Cale Makar', 'David Pastrnak', 'Nikita Kucherov', 'Artemi Panarin',
  ],
  EPL: [
    'Erling Haaland', 'Mohamed Salah', 'Kevin De Bruyne', 'Bukayo Saka',
    'Marcus Rashford', 'Bruno Fernandes', 'Son Heung-min', 'Cole Palmer',
  ],
  MLS: [],
};

// ESPN API endpoints by league
export const ESPN_ENDPOINTS: Record<SportsLeague, string> = {
  NFL: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl',
  NBA: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba',
  MLB: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb',
  NHL: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl',
  EPL: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1',
  MLS: 'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1',
};

// Injury status mapping from ESPN to our types
export const ESPN_STATUS_MAP: Record<string, InjuryStatus> = {
  'Out': 'out',
  'Doubtful': 'doubtful',
  'Questionable': 'questionable',
  'Probable': 'probable',
  'Day-To-Day': 'day-to-day',
  'Injured Reserve': 'ir',
  'Suspension': 'suspended',
  'Active': 'available',
};

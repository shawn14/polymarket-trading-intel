/**
 * Live Game Scores
 *
 * Fetches live scores from ESPN API for sports trade context.
 */

import { ESPN_ENDPOINTS, type SportsLeague } from './types.js';

// Game score snapshot at time of trade
export interface GameScore {
  league: SportsLeague;
  gameId: string;
  homeTeam: string;
  homeAbbr: string;
  homeScore: number;
  awayTeam: string;
  awayAbbr: string;
  awayScore: number;
  period: string;        // "Q3", "2nd", "7th", "OT"
  clock: string;         // "8:42", "12:00", ""
  status: 'pregame' | 'live' | 'halftime' | 'final' | 'delayed' | 'postponed';
  startTime?: string;    // ISO timestamp for pregame
}

// Team name to abbreviation mappings for matching
// Maps team names/nicknames to their abbreviation
const TEAM_NAME_MAP: Record<string, string> = {
  // NFL
  'cardinals': 'ARI', 'arizona': 'ARI',
  'falcons': 'ATL', 'atlanta': 'ATL',
  'ravens': 'BAL', 'baltimore': 'BAL',
  'bills': 'BUF', 'buffalo': 'BUF',
  'panthers': 'CAR', 'carolina': 'CAR',
  'bears': 'CHI', 'chicago': 'CHI',
  'bengals': 'CIN', 'cincinnati': 'CIN',
  'browns': 'CLE', 'cleveland': 'CLE',
  'cowboys': 'DAL', 'dallas': 'DAL',
  'broncos': 'DEN', 'denver': 'DEN',
  'lions': 'DET', 'detroit': 'DET',
  'packers': 'GB', 'green bay': 'GB',
  'texans': 'HOU', 'houston': 'HOU',
  'colts': 'IND', 'indianapolis': 'IND',
  'jaguars': 'JAX', 'jacksonville': 'JAX',
  'chiefs': 'KC', 'kansas city': 'KC',
  'raiders': 'LV', 'las vegas': 'LV', 'vegas': 'LV',
  'chargers': 'LAC',
  'rams': 'LAR',
  'dolphins': 'MIA', 'miami': 'MIA',
  'vikings': 'MIN', 'minnesota': 'MIN',
  'patriots': 'NE', 'new england': 'NE',
  'saints': 'NO',
  'giants': 'NYG',
  'jets': 'NYJ',
  'eagles': 'PHI', 'philadelphia': 'PHI',
  'steelers': 'PIT', 'pittsburgh': 'PIT',
  '49ers': 'SF', 'niners': 'SF', 'san francisco 49ers': 'SF',
  'seahawks': 'SEA', 'seattle': 'SEA',
  'buccaneers': 'TB', 'tampa bay': 'TB', 'bucs': 'TB',
  'titans': 'TEN', 'tennessee': 'TEN',
  'commanders': 'WAS', 'washington': 'WAS',
  // NBA
  'celtics': 'BOS', 'boston celtics': 'BOS',
  'nets': 'BKN', 'brooklyn': 'BKN',
  'knicks': 'NYK',
  'raptors': 'TOR', 'toronto': 'TOR',
  'bucks': 'MIL', 'milwaukee': 'MIL',
  'hornets': 'CHA', 'charlotte': 'CHA',
  'magic': 'ORL', 'orlando': 'ORL',
  'suns': 'PHX', 'phoenix': 'PHX',
  'kings': 'SAC', 'sacramento': 'SAC',
  'warriors': 'GSW', 'golden state': 'GSW',
  'lakers': 'LAL', 'la lakers': 'LAL', 'los angeles lakers': 'LAL',
  'clippers': 'LACB', 'la clippers': 'LACB',
  'blazers': 'POR', 'trail blazers': 'POR', 'portland': 'POR',
  'jazz': 'UTA', 'utah': 'UTA',
  'thunder': 'OKC', 'oklahoma city': 'OKC',
  'spurs': 'SAS', 'san antonio': 'SAS',
  'pelicans': 'NOP', 'new orleans pelicans': 'NOP',
  'grizzlies': 'MEM', 'memphis': 'MEM',
  'heat': 'MIA', 'miami heat': 'MIA',
  'bulls': 'CHI', 'chicago bulls': 'CHI',
  'cavaliers': 'CLE', 'cleveland cavaliers': 'CLE', 'cavs': 'CLE',
  'pistons': 'DET', 'detroit pistons': 'DET',
  'pacers': 'IND', 'indiana': 'IND',
  'hawks': 'ATL', 'atlanta hawks': 'ATL',
  'wizards': 'WAS', 'washington wizards': 'WAS',
  'mavericks': 'DAL', 'dallas mavericks': 'DAL', 'mavs': 'DAL',
  'rockets': 'HOU', 'houston rockets': 'HOU',
  'nuggets': 'DEN', 'denver nuggets': 'DEN',
  'timberwolves': 'MIN', 'minnesota timberwolves': 'MIN', 'wolves': 'MIN',
  // MLB
  'yankees': 'NYY', 'new york yankees': 'NYY',
  'mets': 'NYM', 'new york mets': 'NYM',
  'red sox': 'BOS', 'boston red sox': 'BOS',
  'dodgers': 'LAD', 'los angeles dodgers': 'LAD',
  'padres': 'SD', 'san diego': 'SD',
  'rangers': 'TEX', 'texas': 'TEX',
  'mariners': 'SEA', 'seattle mariners': 'SEA',
  'cubs': 'CHC', 'chicago cubs': 'CHC',
  'white sox': 'CWS', 'chicago white sox': 'CWS',
  'braves': 'ATL', 'atlanta braves': 'ATL',
  'phillies': 'PHI', 'philadelphia phillies': 'PHI',
  'astros': 'HOU', 'houston astros': 'HOU',
};

/**
 * Parse teams from a Polymarket market title
 * Examples:
 * - "Seahawks vs Patriots" -> ['SEA', 'NE']
 * - "Will the Lakers beat the Celtics?" -> ['LAL', 'BOS']
 * - "NBA: Pistons to win" -> ['DET']
 */
export function parseTeamsFromTitle(title: string): string[] {
  const teams: string[] = [];
  const titleLower = title.toLowerCase();

  for (const [name, abbr] of Object.entries(TEAM_NAME_MAP)) {
    if (titleLower.includes(name)) {
      if (!teams.includes(abbr)) {
        teams.push(abbr);
      }
    }
  }

  return teams;
}

/**
 * Detect league from market title
 */
export function detectLeague(title: string): SportsLeague | null {
  const titleUpper = title.toUpperCase();

  if (titleUpper.includes('NFL') || titleUpper.includes('SUPER BOWL')) return 'NFL';
  if (titleUpper.includes('NBA') || titleUpper.includes('FINALS')) return 'NBA';
  if (titleUpper.includes('MLB') || titleUpper.includes('WORLD SERIES')) return 'MLB';
  if (titleUpper.includes('NHL') || titleUpper.includes('STANLEY CUP')) return 'NHL';
  if (titleUpper.includes('EPL') || titleUpper.includes('PREMIER LEAGUE')) return 'EPL';
  if (titleUpper.includes('MLS')) return 'MLS';

  // Check for team names to infer league
  const nflTeams = ['SEAHAWKS', 'PATRIOTS', 'CHIEFS', 'COWBOYS', 'EAGLES', 'BILLS', 'RAVENS', 'PACKERS', '49ERS', 'DOLPHINS'];
  const nbaTeams = ['LAKERS', 'CELTICS', 'WARRIORS', 'BULLS', 'HEAT', 'NETS', 'KNICKS', 'SUNS', 'BUCKS', 'PISTONS', 'MAVERICKS', 'GRIZZLIES'];
  const mlbTeams = ['YANKEES', 'DODGERS', 'RED SOX', 'CUBS', 'METS', 'PADRES', 'BRAVES'];

  if (nflTeams.some(t => titleUpper.includes(t))) return 'NFL';
  if (nbaTeams.some(t => titleUpper.includes(t))) return 'NBA';
  if (mlbTeams.some(t => titleUpper.includes(t))) return 'MLB';

  return null;
}

/**
 * Fetch current scoreboard for a league
 */
export async function fetchScoreboard(league: SportsLeague): Promise<GameScore[]> {
  const endpoint = ESPN_ENDPOINTS[league];
  const url = `${endpoint}/scoreboard`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`ESPN API error: ${response.status}`);
    }

    const data = await response.json() as ESPNScoreboardResponse;
    return parseScoreboard(data, league);
  } catch (error) {
    console.error(`[Scores] Error fetching ${league} scoreboard:`, error);
    return [];
  }
}

interface ESPNScoreboardResponse {
  events?: ESPNEvent[];
}

interface ESPNEvent {
  id: string;
  competitions?: ESPNCompetition[];
}

interface ESPNCompetition {
  id: string;
  status?: {
    type?: { name?: string; state?: string };
    period?: number;
    displayClock?: string;
  };
  startDate?: string;
  competitors?: ESPNCompetitor[];
}

interface ESPNCompetitor {
  homeAway?: 'home' | 'away';
  team?: { displayName?: string; abbreviation?: string };
  score?: string;
}

function parseScoreboard(data: ESPNScoreboardResponse, league: SportsLeague): GameScore[] {
  const scores: GameScore[] = [];

  for (const event of data.events || []) {
    const competition = event.competitions?.[0];
    if (!competition) continue;

    const home = competition.competitors?.find(c => c.homeAway === 'home');
    const away = competition.competitors?.find(c => c.homeAway === 'away');

    if (!home?.team || !away?.team) continue;

    const statusName = competition.status?.type?.name || '';
    const statusState = competition.status?.type?.state || '';

    let status: GameScore['status'] = 'pregame';
    if (statusState === 'in') status = 'live';
    else if (statusName === 'STATUS_HALFTIME') status = 'halftime';
    else if (statusState === 'post') status = 'final';
    else if (statusName === 'STATUS_DELAYED') status = 'delayed';
    else if (statusName === 'STATUS_POSTPONED') status = 'postponed';

    const period = competition.status?.period || 0;
    let periodStr = '';
    if (league === 'NFL' || league === 'NBA') {
      periodStr = period > 4 ? 'OT' : `Q${period}`;
    } else if (league === 'NHL') {
      periodStr = period > 3 ? 'OT' : `P${period}`;
    } else if (league === 'MLB') {
      periodStr = `${period}${getOrdinal(period)}`;
    } else {
      periodStr = period > 2 ? 'ET' : `${period}H`;
    }

    scores.push({
      league,
      gameId: event.id,
      homeTeam: home.team.displayName || '',
      homeAbbr: home.team.abbreviation || '',
      homeScore: parseInt(home.score || '0', 10),
      awayTeam: away.team.displayName || '',
      awayAbbr: away.team.abbreviation || '',
      awayScore: parseInt(away.score || '0', 10),
      period: periodStr,
      clock: competition.status?.displayClock || '',
      status,
      startTime: competition.startDate,
    });
  }

  return scores;
}

function getOrdinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

/**
 * Find the matching game for teams
 */
export function findGameForTeams(scores: GameScore[], teams: string[]): GameScore | null {
  if (teams.length === 0) return null;

  for (const score of scores) {
    const gameTeams = [score.homeAbbr.toUpperCase(), score.awayAbbr.toUpperCase()];
    const matchCount = teams.filter(t => gameTeams.includes(t.toUpperCase())).length;

    // Match if at least one team matches (for single-team bets like "Lakers to win")
    if (matchCount >= 1) {
      return score;
    }
  }

  return null;
}

/**
 * Format game score for display
 * Returns: "SEA 14-10 Q3 8:42" or "Pregame 7:00 PM" or "Final SEA 27-17"
 */
export function formatGameScore(score: GameScore): string {
  if (score.status === 'pregame') {
    const time = score.startTime ? new Date(score.startTime).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }) : '';
    return `Pregame${time ? ' ' + time : ''}`;
  }

  if (score.status === 'final') {
    const winner = score.homeScore > score.awayScore ? score.homeAbbr : score.awayAbbr;
    const winScore = Math.max(score.homeScore, score.awayScore);
    const loseScore = Math.min(score.homeScore, score.awayScore);
    return `Final ${winner} ${winScore}-${loseScore}`;
  }

  if (score.status === 'halftime') {
    return `${score.awayAbbr} ${score.awayScore}-${score.homeScore} Half`;
  }

  if (score.status === 'delayed' || score.status === 'postponed') {
    return score.status.charAt(0).toUpperCase() + score.status.slice(1);
  }

  // Live game
  const clock = score.clock ? ` ${score.clock}` : '';
  return `${score.awayAbbr} ${score.awayScore}-${score.homeScore} ${score.period}${clock}`;
}

// Cache for scoreboards (refresh every 30 seconds)
const scoreboardCache: Map<SportsLeague, { scores: GameScore[]; timestamp: number }> = new Map();
const CACHE_TTL_MS = 30 * 1000;

/**
 * Get game score for a market title (with caching)
 */
export async function getGameScoreForMarket(marketTitle: string): Promise<GameScore | null> {
  const league = detectLeague(marketTitle);
  if (!league) return null;

  const teams = parseTeamsFromTitle(marketTitle);
  if (teams.length === 0) return null;

  // Check cache
  const cached = scoreboardCache.get(league);
  const now = Date.now();

  let scores: GameScore[];
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    scores = cached.scores;
  } else {
    scores = await fetchScoreboard(league);
    scoreboardCache.set(league, { scores, timestamp: now });
  }

  return findGameForTeams(scores, teams);
}

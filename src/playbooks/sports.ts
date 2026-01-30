/**
 * Sports Playbook
 *
 * Tracks game day timing, injury report windows, and lineup confirmations.
 * Key truth source: Official injury reports and lineup cards
 */

import type {
  Playbook,
  PlaybookStatus,
  PlaybookPhase,
  KeyEvent,
  Countdown,
  PlaybookSignal,
  SportsGameState,
} from './types.js';

// Injury report schedules by league (all times ET)
const INJURY_REPORT_WINDOWS = {
  NFL: {
    // Wednesday, Thursday, Friday reports; Saturday final
    reportDays: [3, 4, 5, 6], // Wed, Thu, Fri, Sat
    reportTime: 16, // 4 PM ET
    description: 'NFL injury reports: Wed-Fri practice reports, Sat final',
  },
  NBA: {
    // Daily, key window before games
    reportDays: [0, 1, 2, 3, 4, 5, 6], // Every day
    reportTime: 17, // 5 PM ET (1:30 before most games)
    description: 'NBA injury reports: Released ~5:30 PM ET day of game',
  },
  MLB: {
    // Lineups posted ~2 hours before first pitch
    reportDays: [0, 1, 2, 3, 4, 5, 6],
    reportTime: 17, // Varies by game time
    description: 'MLB lineups: Posted ~2 hours before first pitch',
  },
  NHL: {
    // Morning skate reveals, official lineup ~1 hour before
    reportDays: [0, 1, 2, 3, 4, 5, 6],
    reportTime: 17,
    description: 'NHL lineups: Confirmed ~1 hour before puck drop',
  },
};

// Player prop keywords
const PLAYER_PROP_KEYWORDS = [
  'points', 'rebounds', 'assists', 'steals', 'blocks', '3-pointers',
  'passing yards', 'rushing yards', 'receiving yards', 'touchdowns', 'receptions',
  'hits', 'runs', 'rbi', 'strikeouts', 'home runs',
  'goals', 'assists', 'saves', 'shots',
  'o/u', 'over/under', 'over', 'under',
];

// Team outcome keywords
const TEAM_OUTCOME_KEYWORDS = [
  'win', 'beat', 'defeat', 'cover', 'spread',
  'make playoffs', 'win division', 'win championship',
  'super bowl', 'world series', 'stanley cup', 'nba finals',
];

export class SportsPlaybook implements Playbook {
  readonly category = 'sports_player' as const; // Also handles sports_outcome

  private trackedGames: Map<string, SportsGameState> = new Map();

  matches(question: string, description: string): boolean {
    const text = `${question} ${description}`.toLowerCase();

    // Check for player props
    if (PLAYER_PROP_KEYWORDS.some((kw) => text.includes(kw))) {
      return true;
    }

    // Check for team outcomes
    if (TEAM_OUTCOME_KEYWORDS.some((kw) => text.includes(kw))) {
      return true;
    }

    // Check for specific leagues
    const leagues = ['nfl', 'nba', 'mlb', 'nhl', 'premier league', 'mls'];
    if (leagues.some((league) => text.includes(league))) {
      return true;
    }

    return false;
  }

  async analyze(
    marketId: string,
    question: string,
    currentPrice: number
  ): Promise<PlaybookStatus> {
    const signals: PlaybookSignal[] = [];
    const league = this.detectLeague(question);
    const isPlayerProp = this.isPlayerProp(question);
    const phase = this.determinePhase(question, league);
    const urgency = this.determineUrgency(phase, isPlayerProp);

    // Check if we're in injury report window
    if (league && this.isInReportWindow(league)) {
      const window = INJURY_REPORT_WINDOWS[league as keyof typeof INJURY_REPORT_WINDOWS];
      signals.push({
        type: 'injury_window',
        description: window.description,
        strength: 'moderate',
        timestamp: Date.now(),
      });
    }

    // Extract player name if player prop
    if (isPlayerProp) {
      const playerName = this.extractPlayerName(question);
      if (playerName) {
        signals.push({
          type: 'player_market',
          description: `Player prop for: ${playerName}`,
          strength: 'weak',
          timestamp: Date.now(),
          data: { player: playerName },
        });
      }

      // Check for tracked injury status
      // This would integrate with the Sports client data
    }

    // Game day detection
    const gameState = this.findRelevantGame(question);
    if (gameState) {
      if (gameState.status === 'pregame') {
        signals.push({
          type: 'game_today',
          description: `Game today: ${gameState.awayTeam} @ ${gameState.homeTeam}`,
          strength: 'strong',
          timestamp: Date.now(),
        });

        if (gameState.lineupConfirmed) {
          signals.push({
            type: 'lineup_confirmed',
            description: 'Official lineup has been posted',
            strength: 'strong',
            timestamp: Date.now(),
          });
        }
      } else if (gameState.status === 'in_progress') {
        signals.push({
          type: 'game_in_progress',
          description: 'Game currently in progress',
          strength: 'strong',
          timestamp: Date.now(),
        });
      } else if (gameState.status === 'final') {
        signals.push({
          type: 'game_final',
          description: 'Game has concluded',
          strength: 'strong',
          timestamp: Date.now(),
        });
      } else if (gameState.status === 'postponed') {
        signals.push({
          type: 'game_postponed',
          description: 'Game has been postponed',
          strength: 'strong',
          timestamp: Date.now(),
        });
      }

      // Player status if available
      if (gameState.playerStatus) {
        signals.push({
          type: 'player_status',
          description: `${gameState.playerStatus.name}: ${gameState.playerStatus.status}`,
          strength: gameState.playerStatus.inLineup ? 'strong' : 'moderate',
          timestamp: Date.now(),
          data: gameState.playerStatus,
        });
      }
    }

    return {
      category: isPlayerProp ? 'sports_player' : 'sports_outcome',
      marketId,
      question,
      phase,
      urgency,
      countdown: this.getCountdown(gameState),
      signals,
      nextKeyEvent: this.getNextKeyEvent(league, gameState),
      recommendation: this.generateRecommendation(signals, currentPrice, isPlayerProp),
      lastUpdated: Date.now(),
    };
  }

  getKeyDates(): KeyEvent[] {
    const events: KeyEvent[] = [];
    const now = new Date();

    // Add next injury report windows for major leagues
    for (const [league, window] of Object.entries(INJURY_REPORT_WINDOWS)) {
      const reportTime = new Date(now);
      reportTime.setHours(window.reportTime, 0, 0, 0);

      if (reportTime > now) {
        events.push({
          name: `${league} Report Window`,
          timestamp: reportTime.getTime(),
          description: window.description,
          impact: 'high',
        });
      }
    }

    return events.sort((a, b) => a.timestamp - b.timestamp).slice(0, 4);
  }

  /**
   * Update tracked game state
   */
  trackGame(game: SportsGameState): void {
    this.trackedGames.set(game.gameId, game);
  }

  /**
   * Update player status in a game
   */
  updatePlayerStatus(
    gameId: string,
    playerName: string,
    status: string,
    inLineup: boolean
  ): void {
    const game = this.trackedGames.get(gameId);
    if (game) {
      game.playerStatus = { name: playerName, status, inLineup };
    }
  }

  private detectLeague(question: string): string | undefined {
    const qLower = question.toLowerCase();

    if (qLower.includes('nfl') || qLower.includes('touchdown') || qLower.includes('passing yards')) {
      return 'NFL';
    }
    if (qLower.includes('nba') || (qLower.includes('points') && qLower.includes('rebounds'))) {
      return 'NBA';
    }
    if (qLower.includes('mlb') || qLower.includes('home run') || qLower.includes('strikeout')) {
      return 'MLB';
    }
    if (qLower.includes('nhl') || qLower.includes('hockey') || qLower.includes('puck')) {
      return 'NHL';
    }
    if (qLower.includes('premier league') || qLower.includes('epl')) {
      return 'EPL';
    }

    return undefined;
  }

  private isPlayerProp(question: string): boolean {
    const qLower = question.toLowerCase();
    return PLAYER_PROP_KEYWORDS.some((kw) => qLower.includes(kw));
  }

  private extractPlayerName(question: string): string | undefined {
    // Simple extraction: look for "Name:" pattern or first capitalized name
    const colonMatch = question.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+):/);
    if (colonMatch) return colonMatch[1];

    // Look for name before common stat words
    const statMatch = question.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z'.]+)+)\s*(?:points|rebounds|yards|touchdowns)/i);
    if (statMatch) return statMatch[1];

    return undefined;
  }

  private isInReportWindow(league: string): boolean {
    const window = INJURY_REPORT_WINDOWS[league as keyof typeof INJURY_REPORT_WINDOWS];
    if (!window) return false;

    const now = new Date();
    const day = now.getDay();
    const hour = now.getHours();

    // Check if it's a report day
    if (!window.reportDays.includes(day)) return false;

    // Within 2 hours of report time
    return Math.abs(hour - window.reportTime) <= 2;
  }

  private findRelevantGame(question: string): SportsGameState | undefined {
    const qLower = question.toLowerCase();

    for (const [, game] of this.trackedGames) {
      if (
        qLower.includes(game.homeTeam.toLowerCase()) ||
        qLower.includes(game.awayTeam.toLowerCase())
      ) {
        return game;
      }

      if (game.playerStatus && qLower.includes(game.playerStatus.name.toLowerCase())) {
        return game;
      }
    }

    return undefined;
  }

  private determinePhase(question: string, league?: string): PlaybookPhase {
    const game = this.findRelevantGame(question);

    if (!game) {
      // Check if we're in pre-game window
      if (league && this.isInReportWindow(league)) {
        return 'approaching';
      }
      return 'monitoring';
    }

    switch (game.status) {
      case 'in_progress':
        return 'active';
      case 'final':
        return 'settled';
      case 'pregame':
        const hoursToGame = (game.gameTime - Date.now()) / (1000 * 60 * 60);
        if (hoursToGame <= 1) return 'imminent';
        if (hoursToGame <= 6) return 'approaching';
        return 'monitoring';
      case 'postponed':
        return 'monitoring';
      default:
        return 'monitoring';
    }
  }

  private determineUrgency(phase: PlaybookPhase, isPlayerProp: boolean): PlaybookStatus['urgency'] {
    // Player props have higher urgency as they depend on playing status
    if (isPlayerProp) {
      switch (phase) {
        case 'active':
        case 'settled':
          return 'critical';
        case 'imminent':
          return 'critical';
        case 'approaching':
          return 'high';
        default:
          return 'medium';
      }
    }

    switch (phase) {
      case 'active':
        return 'high';
      case 'imminent':
        return 'high';
      case 'approaching':
        return 'medium';
      default:
        return 'low';
    }
  }

  private getCountdown(game?: SportsGameState): Countdown | undefined {
    if (!game || game.status !== 'pregame' && game.status !== 'scheduled') {
      return undefined;
    }

    const remaining = game.gameTime - Date.now();
    const days = Math.floor(remaining / (1000 * 60 * 60 * 24));
    const hours = Math.floor((remaining % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

    return {
      eventName: 'Game Time',
      targetTimestamp: game.gameTime,
      daysRemaining: Math.max(0, days),
      hoursRemaining: Math.max(0, hours),
      isOverdue: remaining < 0,
    };
  }

  private getNextKeyEvent(league?: string, game?: SportsGameState): KeyEvent | undefined {
    if (game && (game.status === 'scheduled' || game.status === 'pregame')) {
      return {
        name: 'Game Start',
        timestamp: game.gameTime,
        description: `${game.awayTeam} @ ${game.homeTeam}`,
        impact: 'critical',
      };
    }

    if (league) {
      const window = INJURY_REPORT_WINDOWS[league as keyof typeof INJURY_REPORT_WINDOWS];
      if (window) {
        const now = new Date();
        const reportTime = new Date(now);
        reportTime.setHours(window.reportTime, 0, 0, 0);

        if (reportTime > now) {
          return {
            name: `${league} Injury Report`,
            timestamp: reportTime.getTime(),
            description: window.description,
            impact: 'high',
          };
        }
      }
    }

    return undefined;
  }

  private generateRecommendation(
    signals: PlaybookSignal[],
    currentPrice: number,
    isPlayerProp: boolean
  ): PlaybookStatus['recommendation'] {
    const gameInProgress = signals.some((s) => s.type === 'game_in_progress');
    const gameFinal = signals.some((s) => s.type === 'game_final');
    const playerOut = signals.some(
      (s) => s.type === 'player_status' && (s.data as { inLineup?: boolean })?.inLineup === false
    );
    const lineupConfirmed = signals.some((s) => s.type === 'lineup_confirmed');

    // Game final - market should resolve
    if (gameFinal) {
      return {
        action: 'watch',
        confidence: 0.9,
        reasoning: 'Game concluded - awaiting official settlement',
        caveats: ['Verify final stats with official sources'],
      };
    }

    // Game in progress
    if (gameInProgress) {
      return {
        action: 'watch',
        confidence: 0.5,
        reasoning: 'Game in progress - outcome being determined',
        caveats: ['Live odds fluctuating', 'Wait for final result'],
      };
    }

    // Player confirmed OUT for player prop
    if (isPlayerProp && playerOut) {
      return {
        action: currentPrice > 0.1 ? 'consider_no' : 'watch',
        confidence: 0.9,
        reasoning: 'Player ruled OUT - prop should resolve to 0',
        caveats: ['Verify with official injury report', 'Check settlement rules'],
      };
    }

    // Lineup confirmed with player IN
    if (isPlayerProp && lineupConfirmed) {
      return {
        action: 'watch',
        confidence: 0.6,
        reasoning: 'Player confirmed in lineup',
        caveats: ['Playing time/usage still uncertain', 'In-game injury possible'],
      };
    }

    // Pre-game monitoring
    return {
      action: 'watch',
      confidence: 0.3,
      reasoning: isPlayerProp
        ? 'Monitor injury reports for player status'
        : 'Standard pre-game monitoring',
      caveats: isPlayerProp
        ? ['Check official injury report', 'Lineup usually confirmed ~1-2 hours before game']
        : ['Watch for late scratches', 'Weather could affect outdoor games'],
    };
  }
}

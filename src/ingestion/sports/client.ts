/**
 * Sports Client
 *
 * Monitors official injury reports and lineup confirmations via ESPN API.
 * Key use case: Player prop markets, game outcome markets.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type {
  SportsEvent,
  SportsClientConfig,
  SportsLeague,
  InjuryReport,
  InjuryStatus,
} from './types.js';
import { ESPN_ENDPOINTS, ESPN_STATUS_MAP, STAR_PLAYERS } from './types.js';

const DEFAULT_POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_LEAGUES: SportsLeague[] = ['NFL', 'NBA', 'MLB'];

export interface SportsClientEvents {
  event: [event: SportsEvent];
  error: [error: Error];
}

export class SportsClient extends EventEmitter<SportsClientEvents> {
  private config: SportsClientConfig;
  private pollTimer: NodeJS.Timeout | null = null;
  private seenReports: Map<string, InjuryStatus> = new Map(); // playerId -> lastStatus
  private lastPollTime = 0;

  constructor(config: SportsClientConfig = {}) {
    super();
    this.config = {
      leagues: DEFAULT_LEAGUES,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      ...config,
    };
  }

  /**
   * Start monitoring sports injury reports
   */
  start(): void {
    if (this.pollTimer) return;

    const leagues = this.config.leagues?.join(', ') || 'none';
    console.log(`[Sports] Starting monitor (${leagues})`);
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), this.config.pollIntervalMs);
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Get count of tracked players
   */
  getTrackedPlayerCount(): number {
    return this.seenReports.size;
  }

  /**
   * Check if we're in a critical window for a league
   */
  isInjuryReportWindow(league: SportsLeague): boolean {
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay(); // 0 = Sunday

    switch (league) {
      case 'NFL':
        // Wednesday-Friday injury reports, Saturday final
        return day >= 3 && day <= 6;
      case 'NBA':
        // Daily, but key window is 4-7 PM ET (before games)
        return hour >= 16 && hour <= 19;
      case 'MLB':
        // Daily lineups posted ~2 hours before game
        return hour >= 15 && hour <= 20;
      default:
        return true;
    }
  }

  /**
   * Fetch injury reports for a league
   */
  async fetchInjuryReports(league: SportsLeague): Promise<InjuryReport[]> {
    const endpoint = ESPN_ENDPOINTS[league];
    const url = `${endpoint}/injuries`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`ESPN API error: ${response.status}`);
      }

      const data = await response.json();
      return this.parseESPNInjuries(data, league);
    } catch (error) {
      // ESPN injuries endpoint may not exist for all leagues
      // Fall back to team-by-team fetching
      return this.fetchTeamInjuries(league);
    }
  }

  /**
   * Fetch injuries by iterating through teams (fallback)
   */
  private async fetchTeamInjuries(league: SportsLeague): Promise<InjuryReport[]> {
    const endpoint = ESPN_ENDPOINTS[league];
    const reports: InjuryReport[] = [];

    try {
      // Fetch team list
      const teamsUrl = `${endpoint}/teams`;
      const response = await fetch(teamsUrl);
      if (!response.ok) return reports;

      const data = (await response.json()) as {
        sports?: Array<{ leagues?: Array<{ teams?: Array<{ team: { id: string } }> }> }>;
      };
      const teams = data.sports?.[0]?.leagues?.[0]?.teams || [];

      // Limit concurrent requests
      const teamIds = teams.slice(0, 10).map((t) => t.team.id);

      for (const teamId of teamIds) {
        try {
          const teamUrl = `${endpoint}/teams/${teamId}/injuries`;
          const teamResp = await fetch(teamUrl);
          if (teamResp.ok) {
            const teamData = await teamResp.json();
            const teamReports = this.parseESPNInjuries(teamData, league);
            reports.push(...teamReports);
          }
        } catch {
          // Skip failed team fetches
        }

        // Rate limit
        await this.delay(100);
      }
    } catch {
      // Silently fail - some leagues don't support this
    }

    return reports;
  }

  /**
   * Parse ESPN injury response
   */
  private parseESPNInjuries(data: unknown, league: SportsLeague): InjuryReport[] {
    const reports: InjuryReport[] = [];
    const injuries = (data as { injuries?: unknown[] })?.injuries || [];

    for (const injury of injuries as Array<{
      athlete?: { displayName?: string; position?: { abbreviation?: string } };
      team?: { displayName?: string; abbreviation?: string };
      status?: string;
      type?: { description?: string };
      date?: string;
    }>) {
      const athlete = injury.athlete;
      const team = injury.team;

      if (!athlete?.displayName || !team?.displayName) continue;

      const status = this.mapInjuryStatus(injury.status || '');
      if (!status) continue;

      reports.push({
        id: `${league}-${team.abbreviation}-${athlete.displayName}`.replace(/\s+/g, '-').toLowerCase(),
        league,
        team: team.displayName,
        teamAbbr: team.abbreviation || '',
        player: athlete.displayName,
        position: athlete.position?.abbreviation || '',
        status,
        injury: injury.type?.description || 'Unknown',
        reportDate: injury.date || new Date().toISOString(),
        source: 'espn',
        isUpdate: false,
      });
    }

    return reports;
  }

  /**
   * Map ESPN status string to our InjuryStatus type
   */
  private mapInjuryStatus(espnStatus: string): InjuryStatus | null {
    // Direct mapping
    if (ESPN_STATUS_MAP[espnStatus]) {
      return ESPN_STATUS_MAP[espnStatus];
    }

    // Fuzzy matching
    const lower = espnStatus.toLowerCase();
    if (lower.includes('out')) return 'out';
    if (lower.includes('doubtful')) return 'doubtful';
    if (lower.includes('questionable')) return 'questionable';
    if (lower.includes('probable')) return 'probable';
    if (lower.includes('day-to-day') || lower.includes('dtd')) return 'day-to-day';
    if (lower.includes('ir') || lower.includes('injured reserve')) return 'ir';
    if (lower.includes('suspend')) return 'suspended';

    return null;
  }

  /**
   * Check if a player is a star (high-profile)
   */
  private isStarPlayer(name: string, league: SportsLeague): boolean {
    const stars = STAR_PLAYERS[league] || [];
    const nameLower = name.toLowerCase();
    return stars.some((star) => nameLower.includes(star.toLowerCase()));
  }

  /**
   * Calculate significance of an injury update
   */
  private calculateSignificance(
    report: InjuryReport,
    previousStatus?: InjuryStatus
  ): SportsEvent['significance'] {
    const isStar = this.isStarPlayer(report.player, report.league);
    const statusChanged = previousStatus && previousStatus !== report.status;

    // Star player ruled out = critical
    if (isStar && report.status === 'out') {
      return 'critical';
    }

    // Star player status change = high
    if (isStar && statusChanged) {
      return 'high';
    }

    // Any player ruled out close to game = high
    if (report.status === 'out' && statusChanged) {
      return 'high';
    }

    // Status upgrade (questionable -> available) = medium
    if (statusChanged && this.isStatusUpgrade(previousStatus!, report.status)) {
      return 'medium';
    }

    // Star player any update = medium
    if (isStar) {
      return 'medium';
    }

    return 'low';
  }

  /**
   * Check if status change is an upgrade (more likely to play)
   */
  private isStatusUpgrade(prev: InjuryStatus, curr: InjuryStatus): boolean {
    const order: InjuryStatus[] = ['out', 'doubtful', 'questionable', 'probable', 'available'];
    const prevIdx = order.indexOf(prev);
    const currIdx = order.indexOf(curr);
    return currIdx > prevIdx;
  }

  /**
   * Poll all configured leagues
   */
  private async poll(): Promise<void> {
    const leagues = this.config.leagues || DEFAULT_LEAGUES;
    let totalNew = 0;

    for (const league of leagues) {
      try {
        const reports = await this.fetchInjuryReports(league);

        for (const report of reports) {
          const key = report.id;
          const previousStatus = this.seenReports.get(key);

          // Check if this is a new or changed report
          if (!previousStatus || previousStatus !== report.status) {
            report.isUpdate = !!previousStatus;
            report.previousStatus = previousStatus;

            const significance = this.calculateSignificance(report, previousStatus);

            // Only emit if significance is medium or higher, or if it's a status change
            if (significance !== 'low' || report.isUpdate) {
              const event: SportsEvent = {
                id: randomUUID(),
                type: 'injury_update',
                league: report.league,
                timestamp: Date.now(),
                injury: report,
                significance,
                headline: this.generateHeadline(report),
                details: this.generateDetails(report),
              };

              this.emit('event', event);
              totalNew++;
            }

            // Track current status
            this.seenReports.set(key, report.status);
          }
        }
      } catch (error) {
        this.emit('error', error instanceof Error ? error : new Error(String(error)));
      }
    }

    this.lastPollTime = Date.now();

    // Clean up old entries (keep last 500)
    if (this.seenReports.size > 500) {
      const entries = [...this.seenReports.entries()];
      this.seenReports = new Map(entries.slice(-300));
    }

    if (totalNew > 0) {
      console.log(`[Sports] ${totalNew} injury updates`);
    }
  }

  /**
   * Generate headline for injury event
   */
  private generateHeadline(report: InjuryReport): string {
    const statusText = report.status.toUpperCase().replace('-', ' ');
    const change = report.isUpdate
      ? ` (was ${report.previousStatus?.toUpperCase()})`
      : '';
    return `${report.league}: ${report.player} ${statusText}${change}`;
  }

  /**
   * Generate details for injury event
   */
  private generateDetails(report: InjuryReport): string {
    const parts = [
      `${report.player} (${report.position}) - ${report.team}`,
      `Status: ${report.status.toUpperCase()}`,
      `Injury: ${report.injury}`,
    ];

    if (report.opponent) {
      parts.push(`Game: vs ${report.opponent}`);
    }

    return parts.join('\n');
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

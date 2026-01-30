/**
 * Hurricane Playbook
 *
 * Tracks tropical systems, NHC advisories, and landfall predictions.
 * Key truth source: NWS/NHC official advisories
 */

import type {
  Playbook,
  PlaybookStatus,
  PlaybookPhase,
  KeyEvent,
  Countdown,
  PlaybookSignal,
  HurricaneState,
  ActiveStorm,
} from './types.js';

// Atlantic hurricane season
const HURRICANE_SEASON = {
  start: { month: 6, day: 1 },   // June 1
  end: { month: 11, day: 30 },   // November 30
  peak: { start: { month: 8, day: 15 }, end: { month: 10, day: 15 } }, // Mid-Aug to Mid-Oct
};

// NHC advisory schedule (every 6 hours when storm active)
const NHC_ADVISORY_TIMES = [5, 11, 17, 23]; // EDT hours

export class HurricanePlaybook implements Playbook {
  readonly category = 'hurricane' as const;

  private state: HurricaneState = {
    activeSystems: [],
    watchesWarnings: [],
    basinActivity: 'quiet',
  };

  matches(question: string, description: string): boolean {
    const text = `${question} ${description}`.toLowerCase();
    return (
      text.includes('hurricane') ||
      text.includes('tropical storm') ||
      text.includes('landfall') ||
      text.includes('make landfall') ||
      (text.includes('category') && (text.includes('storm') || text.includes('atlantic')))
    );
  }

  async analyze(
    marketId: string,
    question: string,
    currentPrice: number
  ): Promise<PlaybookStatus> {
    const signals: PlaybookSignal[] = [];
    const phase = this.determinePhase(question);
    const urgency = this.determineUrgency(phase);

    // Check if we're in hurricane season
    const inSeason = this.isInHurricaneSeason();
    const inPeak = this.isInPeakSeason();

    if (!inSeason) {
      signals.push({
        type: 'off_season',
        description: 'Outside Atlantic hurricane season (Jun 1 - Nov 30)',
        strength: 'strong',
        timestamp: Date.now(),
      });
    } else if (inPeak) {
      signals.push({
        type: 'peak_season',
        description: 'Peak hurricane season (mid-Aug to mid-Oct)',
        strength: 'moderate',
        timestamp: Date.now(),
      });
    }

    // Check for active storms matching market
    const relevantStorm = this.findRelevantStorm(question);
    if (relevantStorm) {
      signals.push({
        type: 'active_storm',
        description: `${relevantStorm.name} active - Category ${relevantStorm.category}`,
        strength: 'strong',
        timestamp: Date.now(),
        data: {
          category: relevantStorm.category,
          windSpeed: relevantStorm.windSpeed,
          movement: relevantStorm.movement,
        },
      });

      if (relevantStorm.forecastLandfall) {
        signals.push({
          type: 'landfall_forecast',
          description: `Landfall forecast: ${relevantStorm.forecastLandfall.location}`,
          strength: relevantStorm.forecastLandfall.probability > 0.7 ? 'strong' : 'moderate',
          timestamp: Date.now(),
          data: relevantStorm.forecastLandfall,
        });
      }
    }

    // Check for watches/warnings
    const activeWW = this.state.watchesWarnings.filter((w) => w.expiresAt > Date.now());
    if (activeWW.length > 0) {
      const warnings = activeWW.filter((w) => w.type.includes('Warning'));
      const watches = activeWW.filter((w) => w.type.includes('Watch'));

      if (warnings.length > 0) {
        signals.push({
          type: 'warnings_active',
          description: `${warnings.length} hurricane/tropical storm warnings active`,
          strength: 'strong',
          timestamp: Date.now(),
        });
      }

      if (watches.length > 0) {
        signals.push({
          type: 'watches_active',
          description: `${watches.length} watches active`,
          strength: 'moderate',
          timestamp: Date.now(),
        });
      }
    }

    // Basin activity level
    if (this.state.basinActivity === 'hyperactive') {
      signals.push({
        type: 'hyperactive_basin',
        description: 'Atlantic basin showing hyperactive conditions',
        strength: 'moderate',
        timestamp: Date.now(),
      });
    }

    return {
      category: 'hurricane',
      marketId,
      question,
      phase,
      urgency,
      countdown: this.getCountdown(relevantStorm),
      signals,
      nextKeyEvent: this.getNextKeyEvent(relevantStorm),
      recommendation: this.generateRecommendation(signals, currentPrice, question),
      lastUpdated: Date.now(),
    };
  }

  getKeyDates(): KeyEvent[] {
    const events: KeyEvent[] = [];
    const now = new Date();
    const year = now.getFullYear();

    // Season start/end
    const seasonStart = new Date(year, 5, 1); // June 1
    const seasonEnd = new Date(year, 10, 30); // November 30
    const peakStart = new Date(year, 7, 15); // August 15
    const peakEnd = new Date(year, 9, 15); // October 15

    if (now < seasonStart) {
      events.push({
        name: 'Hurricane Season Starts',
        timestamp: seasonStart.getTime(),
        description: 'Atlantic hurricane season begins',
        impact: 'medium',
      });
    }

    if (now < peakStart && now >= seasonStart) {
      events.push({
        name: 'Peak Season Begins',
        timestamp: peakStart.getTime(),
        description: 'Peak of Atlantic hurricane season',
        impact: 'high',
      });
    }

    if (now >= peakStart && now < peakEnd) {
      events.push({
        name: 'Peak Season Ends',
        timestamp: peakEnd.getTime(),
        description: 'End of peak hurricane season',
        impact: 'medium',
      });
    }

    // Add NHC advisory times for today
    for (const hour of NHC_ADVISORY_TIMES) {
      const advisoryTime = new Date(now);
      advisoryTime.setHours(hour, 0, 0, 0);
      if (advisoryTime > now && this.state.activeSystems.length > 0) {
        events.push({
          name: 'NHC Advisory',
          timestamp: advisoryTime.getTime(),
          description: 'Next scheduled NHC advisory',
          impact: 'high',
        });
        break; // Only show next one
      }
    }

    return events.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Update state with active storm data
   */
  updateActiveSystems(storms: ActiveStorm[]): void {
    this.state.activeSystems = storms;
    this.state.basinActivity =
      storms.length === 0 ? 'quiet' : storms.length >= 3 ? 'hyperactive' : 'active';
  }

  /**
   * Add a watch or warning
   */
  addWatchWarning(ww: HurricaneState['watchesWarnings'][0]): void {
    // Remove duplicates
    this.state.watchesWarnings = this.state.watchesWarnings.filter(
      (w) => !(w.type === ww.type && w.areas.join() === ww.areas.join())
    );
    this.state.watchesWarnings.push(ww);
  }

  private isInHurricaneSeason(): boolean {
    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();

    if (month < HURRICANE_SEASON.start.month) return false;
    if (month > HURRICANE_SEASON.end.month) return false;
    if (month === HURRICANE_SEASON.start.month && day < HURRICANE_SEASON.start.day) return false;
    if (month === HURRICANE_SEASON.end.month && day > HURRICANE_SEASON.end.day) return false;

    return true;
  }

  private isInPeakSeason(): boolean {
    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();

    const afterPeakStart =
      month > HURRICANE_SEASON.peak.start.month ||
      (month === HURRICANE_SEASON.peak.start.month && day >= HURRICANE_SEASON.peak.start.day);

    const beforePeakEnd =
      month < HURRICANE_SEASON.peak.end.month ||
      (month === HURRICANE_SEASON.peak.end.month && day <= HURRICANE_SEASON.peak.end.day);

    return afterPeakStart && beforePeakEnd;
  }

  private findRelevantStorm(question: string): ActiveStorm | undefined {
    const qLower = question.toLowerCase();
    return this.state.activeSystems.find((storm) =>
      qLower.includes(storm.name.toLowerCase())
    );
  }

  private determinePhase(question: string): PlaybookPhase {
    const storm = this.findRelevantStorm(question);

    if (!storm) {
      if (this.state.activeSystems.length > 0) return 'monitoring';
      return 'monitoring';
    }

    if (storm.forecastLandfall) {
      const hoursToLandfall =
        (storm.forecastLandfall.timestamp - Date.now()) / (1000 * 60 * 60);

      if (hoursToLandfall <= 0) return 'active';
      if (hoursToLandfall <= 24) return 'imminent';
      if (hoursToLandfall <= 72) return 'approaching';
    }

    // Has warnings = approaching/imminent
    const hasWarnings = this.state.watchesWarnings.some(
      (w) => w.type.includes('Warning') && w.expiresAt > Date.now()
    );
    if (hasWarnings) return 'imminent';

    const hasWatches = this.state.watchesWarnings.some(
      (w) => w.type.includes('Watch') && w.expiresAt > Date.now()
    );
    if (hasWatches) return 'approaching';

    return 'monitoring';
  }

  private determineUrgency(phase: PlaybookPhase): PlaybookStatus['urgency'] {
    switch (phase) {
      case 'active':
        return 'critical';
      case 'imminent':
        return 'critical';
      case 'approaching':
        return 'high';
      default:
        return 'medium';
    }
  }

  private getCountdown(storm?: ActiveStorm): Countdown | undefined {
    if (!storm?.forecastLandfall) return undefined;

    const remaining = storm.forecastLandfall.timestamp - Date.now();
    const days = Math.floor(remaining / (1000 * 60 * 60 * 24));
    const hours = Math.floor((remaining % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

    return {
      eventName: `${storm.name} Landfall`,
      targetTimestamp: storm.forecastLandfall.timestamp,
      daysRemaining: Math.max(0, days),
      hoursRemaining: Math.max(0, hours),
      isOverdue: remaining < 0,
    };
  }

  private getNextKeyEvent(storm?: ActiveStorm): KeyEvent | undefined {
    if (storm?.forecastLandfall) {
      return {
        name: `${storm.name} Landfall`,
        timestamp: storm.forecastLandfall.timestamp,
        description: `Forecast landfall at ${storm.forecastLandfall.location}`,
        impact: 'critical',
      };
    }

    const events = this.getKeyDates();
    return events[0];
  }

  private generateRecommendation(
    signals: PlaybookSignal[],
    currentPrice: number,
    question: string
  ): PlaybookStatus['recommendation'] {
    const isOffSeason = signals.some((s) => s.type === 'off_season');
    const hasLandfallForecast = signals.some((s) => s.type === 'landfall_forecast');
    const hasWarnings = signals.some((s) => s.type === 'warnings_active');

    // Off season = very unlikely for new storms
    if (isOffSeason && currentPrice > 0.2) {
      return {
        action: 'consider_no',
        confidence: 0.7,
        reasoning: 'Outside hurricane season - new storm formation unlikely',
        caveats: ['Off-season storms are rare but possible', 'Check for existing systems'],
      };
    }

    // Landfall forecast with warnings = high confidence
    if (hasLandfallForecast && hasWarnings) {
      return {
        action: 'watch',
        confidence: 0.6,
        reasoning: 'Storm approaching with active warnings - outcome becoming clearer',
        caveats: ['Track can still shift', 'Intensity forecasts have uncertainty'],
      };
    }

    // Active warnings but no specific landfall
    if (hasWarnings) {
      return {
        action: 'watch',
        confidence: 0.5,
        reasoning: 'Warnings active - heightened uncertainty',
        caveats: ['Wait for more specific forecasts', 'Price likely volatile'],
      };
    }

    return {
      action: 'watch',
      confidence: 0.3,
      reasoning: 'Monitoring NHC advisories',
      caveats: ['Check NHC.gov for latest', 'Advisory schedule: 5am, 11am, 5pm, 11pm EDT'],
    };
  }
}

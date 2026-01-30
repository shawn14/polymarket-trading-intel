/**
 * Fed Decision Playbook
 *
 * Tracks FOMC meetings, rate decisions, and Fed communication.
 * Key truth source: Federal Reserve official releases
 */

import type {
  Playbook,
  PlaybookStatus,
  PlaybookPhase,
  KeyEvent,
  Countdown,
  PlaybookSignal,
  FedState,
  FOMCMeeting,
} from './types.js';

// FOMC meeting schedule (2-day meetings, announcement at 2:00 PM ET on day 2)
const FOMC_MEETINGS_2025: FOMCMeeting[] = [
  { dates: ['2025-01-28', '2025-01-29'], announcementTime: 0, hasSEP: false, hasPressConference: true },
  { dates: ['2025-03-18', '2025-03-19'], announcementTime: 0, hasSEP: true, hasPressConference: true },
  { dates: ['2025-05-06', '2025-05-07'], announcementTime: 0, hasSEP: false, hasPressConference: true },
  { dates: ['2025-06-17', '2025-06-18'], announcementTime: 0, hasSEP: true, hasPressConference: true },
  { dates: ['2025-07-29', '2025-07-30'], announcementTime: 0, hasSEP: false, hasPressConference: true },
  { dates: ['2025-09-16', '2025-09-17'], announcementTime: 0, hasSEP: true, hasPressConference: true },
  { dates: ['2025-11-05', '2025-11-06'], announcementTime: 0, hasSEP: false, hasPressConference: true },
  { dates: ['2025-12-16', '2025-12-17'], announcementTime: 0, hasSEP: true, hasPressConference: true },
];

const FOMC_MEETINGS_2026: FOMCMeeting[] = [
  { dates: ['2026-01-27', '2026-01-28'], announcementTime: 0, hasSEP: false, hasPressConference: true },
  { dates: ['2026-03-17', '2026-03-18'], announcementTime: 0, hasSEP: true, hasPressConference: true },
  { dates: ['2026-04-28', '2026-04-29'], announcementTime: 0, hasSEP: false, hasPressConference: true },
  { dates: ['2026-06-16', '2026-06-17'], announcementTime: 0, hasSEP: true, hasPressConference: true },
  { dates: ['2026-07-28', '2026-07-29'], announcementTime: 0, hasSEP: false, hasPressConference: true },
  { dates: ['2026-09-15', '2026-09-16'], announcementTime: 0, hasSEP: true, hasPressConference: true },
  { dates: ['2026-11-03', '2026-11-04'], announcementTime: 0, hasSEP: false, hasPressConference: true },
  { dates: ['2026-12-15', '2026-12-16'], announcementTime: 0, hasSEP: true, hasPressConference: true },
];

const ALL_FOMC_MEETINGS = [...FOMC_MEETINGS_2025, ...FOMC_MEETINGS_2026];

// Announcement is at 2:00 PM ET on day 2
const ANNOUNCEMENT_HOUR_ET = 14;

// Blackout period starts Saturday before meeting week
const BLACKOUT_DAYS_BEFORE = 10;

export class FedDecisionPlaybook implements Playbook {
  readonly category = 'fed_decision' as const;

  private state: FedState = {
    currentRate: { lower: 4.25, upper: 4.50 }, // As of Jan 2025
    marketExpectations: [],
    inBlackoutPeriod: false,
  };

  matches(question: string, description: string): boolean {
    const text = `${question} ${description}`.toLowerCase();
    return (
      text.includes('fed rate') ||
      text.includes('federal reserve') ||
      text.includes('fomc') ||
      text.includes('rate cut') ||
      text.includes('rate hike') ||
      text.includes('interest rate') ||
      text.includes('basis point') ||
      text.includes('powell')
    );
  }

  async analyze(
    marketId: string,
    question: string,
    currentPrice: number
  ): Promise<PlaybookStatus> {
    const signals: PlaybookSignal[] = [];
    const nextMeeting = this.getNextMeeting();
    const phase = this.determinePhase(nextMeeting);
    const urgency = this.determineUrgency(phase);

    // Check blackout period
    const inBlackout = this.isInBlackoutPeriod(nextMeeting);
    if (inBlackout) {
      signals.push({
        type: 'blackout_period',
        description: 'Fed officials in blackout period - no public comments',
        strength: 'moderate',
        timestamp: Date.now(),
      });
    }

    // Meeting day signals
    if (phase === 'active' && nextMeeting) {
      const isAnnouncementDay = this.isAnnouncementDay(nextMeeting);
      if (isAnnouncementDay) {
        const hoursToAnnouncement = this.getHoursToAnnouncement(nextMeeting);
        if (hoursToAnnouncement > 0) {
          signals.push({
            type: 'announcement_today',
            description: `FOMC announcement in ~${hoursToAnnouncement.toFixed(1)} hours (2:00 PM ET)`,
            strength: 'strong',
            timestamp: Date.now(),
          });
        } else {
          signals.push({
            type: 'announcement_imminent',
            description: 'FOMC announcement should be released',
            strength: 'strong',
            timestamp: Date.now(),
          });
        }
      }
    }

    // SEP meeting (more significant)
    if (nextMeeting?.hasSEP && phase !== 'monitoring') {
      signals.push({
        type: 'sep_meeting',
        description: 'This meeting includes Summary of Economic Projections (dot plot)',
        strength: 'moderate',
        timestamp: Date.now(),
      });
    }

    // Analyze market question for rate direction
    const questionLower = question.toLowerCase();
    const isRateCutMarket = questionLower.includes('cut') || questionLower.includes('lower');
    const isRateHikeMarket = questionLower.includes('hike') || questionLower.includes('raise');

    // Current rate context
    signals.push({
      type: 'current_rate',
      description: `Current target: ${this.state.currentRate.lower}%-${this.state.currentRate.upper}%`,
      strength: 'weak',
      timestamp: Date.now(),
      data: this.state.currentRate,
    });

    // Price-based analysis
    if (currentPrice > 0.8) {
      signals.push({
        type: 'market_expects_action',
        description: `Market pricing ${(currentPrice * 100).toFixed(0)}% probability`,
        strength: 'strong',
        timestamp: Date.now(),
      });
    } else if (currentPrice < 0.2) {
      signals.push({
        type: 'market_expects_no_action',
        description: `Market pricing only ${(currentPrice * 100).toFixed(0)}% probability`,
        strength: 'strong',
        timestamp: Date.now(),
      });
    }

    return {
      category: 'fed_decision',
      marketId,
      question,
      phase,
      urgency,
      countdown: this.getCountdown(nextMeeting),
      signals,
      nextKeyEvent: this.getNextKeyEvent(nextMeeting),
      recommendation: this.generateRecommendation(signals, currentPrice, isRateCutMarket, isRateHikeMarket),
      lastUpdated: Date.now(),
    };
  }

  getKeyDates(): KeyEvent[] {
    const events: KeyEvent[] = [];
    const now = Date.now();

    for (const meeting of ALL_FOMC_MEETINGS) {
      const announcementDate = new Date(meeting.dates[1]);
      announcementDate.setHours(ANNOUNCEMENT_HOUR_ET, 0, 0, 0);

      if (announcementDate.getTime() > now) {
        events.push({
          name: 'FOMC Announcement',
          timestamp: announcementDate.getTime(),
          description: meeting.hasSEP
            ? 'FOMC decision + SEP + Press Conference'
            : 'FOMC decision + Press Conference',
          impact: 'critical',
        });
      }
    }

    return events.slice(0, 4); // Next 4 meetings
  }

  /**
   * Update current rate
   */
  setCurrentRate(lower: number, upper: number): void {
    this.state.currentRate = { lower, upper };
  }

  /**
   * Update market expectations
   */
  setMarketExpectations(expectations: FedState['marketExpectations']): void {
    this.state.marketExpectations = expectations;
  }

  private getNextMeeting(): FOMCMeeting | undefined {
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    for (const meeting of ALL_FOMC_MEETINGS) {
      // Meeting is relevant if we're before or on day 2
      if (meeting.dates[1] >= today) {
        return meeting;
      }
    }

    return undefined;
  }

  private isInBlackoutPeriod(meeting?: FOMCMeeting): boolean {
    if (!meeting) return false;

    const meetingStart = new Date(meeting.dates[0]);
    const blackoutStart = new Date(meetingStart);
    blackoutStart.setDate(blackoutStart.getDate() - BLACKOUT_DAYS_BEFORE);

    const meetingEnd = new Date(meeting.dates[1]);
    meetingEnd.setHours(23, 59, 59);

    const now = new Date();
    return now >= blackoutStart && now <= meetingEnd;
  }

  private isAnnouncementDay(meeting: FOMCMeeting): boolean {
    const today = new Date().toISOString().split('T')[0];
    return meeting.dates[1] === today;
  }

  private getHoursToAnnouncement(meeting: FOMCMeeting): number {
    const announcementTime = new Date(meeting.dates[1]);
    announcementTime.setHours(ANNOUNCEMENT_HOUR_ET, 0, 0, 0);

    return (announcementTime.getTime() - Date.now()) / (1000 * 60 * 60);
  }

  private determinePhase(meeting?: FOMCMeeting): PlaybookPhase {
    if (!meeting) return 'monitoring';

    const now = new Date();
    const today = now.toISOString().split('T')[0];

    // On meeting days
    if (today === meeting.dates[0] || today === meeting.dates[1]) {
      if (today === meeting.dates[1]) {
        const hoursToAnnouncement = this.getHoursToAnnouncement(meeting);
        if (hoursToAnnouncement <= 0) return 'resolution';
      }
      return 'active';
    }

    // Days before meeting
    const meetingDate = new Date(meeting.dates[0]);
    const daysUntil = Math.ceil((meetingDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    if (daysUntil <= 1) return 'imminent';
    if (daysUntil <= 7) return 'approaching';
    return 'monitoring';
  }

  private determineUrgency(phase: PlaybookPhase): PlaybookStatus['urgency'] {
    switch (phase) {
      case 'active':
      case 'resolution':
        return 'critical';
      case 'imminent':
        return 'high';
      case 'approaching':
        return 'medium';
      default:
        return 'low';
    }
  }

  private getCountdown(meeting?: FOMCMeeting): Countdown | undefined {
    if (!meeting) return undefined;

    const announcementTime = new Date(meeting.dates[1]);
    announcementTime.setHours(ANNOUNCEMENT_HOUR_ET, 0, 0, 0);

    const remaining = announcementTime.getTime() - Date.now();
    const days = Math.floor(remaining / (1000 * 60 * 60 * 24));
    const hours = Math.floor((remaining % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

    return {
      eventName: 'FOMC Announcement',
      targetTimestamp: announcementTime.getTime(),
      daysRemaining: Math.max(0, days),
      hoursRemaining: Math.max(0, hours),
      isOverdue: remaining < 0,
    };
  }

  private getNextKeyEvent(meeting?: FOMCMeeting): KeyEvent | undefined {
    if (!meeting) return undefined;

    const announcementTime = new Date(meeting.dates[1]);
    announcementTime.setHours(ANNOUNCEMENT_HOUR_ET, 0, 0, 0);

    return {
      name: 'FOMC Announcement',
      timestamp: announcementTime.getTime(),
      description: meeting.hasSEP ? 'Decision + Dot Plot' : 'Rate Decision',
      impact: 'critical',
    };
  }

  private generateRecommendation(
    signals: PlaybookSignal[],
    currentPrice: number,
    isRateCutMarket: boolean,
    isRateHikeMarket: boolean
  ): PlaybookStatus['recommendation'] {
    const isAnnouncementDay = signals.some(
      (s) => s.type === 'announcement_today' || s.type === 'announcement_imminent'
    );
    const inBlackout = signals.some((s) => s.type === 'blackout_period');

    // On announcement day, high uncertainty
    if (isAnnouncementDay) {
      return {
        action: 'watch',
        confidence: 0.4,
        reasoning: 'FOMC announcement today - wait for official release at 2:00 PM ET',
        caveats: ['Do not trade on rumors', 'Statement language matters as much as rate decision'],
      };
    }

    // In blackout - no new Fed guidance coming
    if (inBlackout) {
      return {
        action: 'watch',
        confidence: 0.5,
        reasoning: 'Fed blackout period - prices reflect existing data',
        caveats: ['Economic data can still move expectations', 'No Fed speeches during blackout'],
      };
    }

    // Far from meeting
    return {
      action: 'watch',
      confidence: 0.3,
      reasoning: 'Monitoring Fed communications and economic data',
      caveats: [
        'Watch for Fed speeches and economic releases',
        'CME FedWatch tool shows market expectations',
      ],
    };
  }
}

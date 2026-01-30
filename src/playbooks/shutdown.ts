/**
 * Government Shutdown Playbook
 *
 * Tracks appropriations deadlines, CR expirations, and shutdown probability.
 * Key truth source: Congress.gov bill status
 */

import type {
  Playbook,
  PlaybookStatus,
  PlaybookPhase,
  KeyEvent,
  Countdown,
  PlaybookSignal,
  ShutdownState,
} from './types.js';

// Known funding deadlines (update as CRs are passed)
const FUNDING_DEADLINES = [
  { date: '2025-03-14', description: 'FY2025 CR Expiration (if extended)' },
  { date: '2025-09-30', description: 'FY2025 End / FY2026 Start' },
  { date: '2026-09-30', description: 'FY2026 End / FY2027 Start' },
];

// Appropriations bill keywords
const APPROPRIATIONS_KEYWORDS = [
  'appropriations act',
  'continuing resolution',
  'continuing appropriations',
  'omnibus',
  'minibus',
  'full-year funding',
  'government funding',
];

export class ShutdownPlaybook implements Playbook {
  readonly category = 'shutdown' as const;

  private state: ShutdownState = {
    currentFunding: 'unknown',
    appropriationsBillsEnacted: 0,
    appropriationsBillsTotal: 12, // 12 annual appropriations bills
    inShutdown: false,
  };

  matches(question: string, description: string): boolean {
    const text = `${question} ${description}`.toLowerCase();
    return (
      text.includes('shutdown') ||
      text.includes('government shutdown') ||
      text.includes('federal shutdown') ||
      (text.includes('funding') && text.includes('lapse'))
    );
  }

  async analyze(
    marketId: string,
    question: string,
    currentPrice: number
  ): Promise<PlaybookStatus> {
    const signals: PlaybookSignal[] = [];
    const phase = this.determinePhase();
    const urgency = this.determineUrgency(phase);
    const countdown = this.getCountdown();

    // Analyze current state
    if (this.state.inShutdown) {
      signals.push({
        type: 'shutdown_active',
        description: 'Government is currently in shutdown',
        strength: 'strong',
        timestamp: Date.now(),
      });
    }

    if (this.state.currentFunding === 'cr') {
      signals.push({
        type: 'cr_funding',
        description: 'Government operating under Continuing Resolution',
        strength: 'moderate',
        timestamp: Date.now(),
        data: { expirationDays: this.state.daysUntilExpiration },
      });
    }

    // Check appropriations progress
    const enactedPct = this.state.appropriationsBillsEnacted / this.state.appropriationsBillsTotal;
    if (enactedPct >= 1.0) {
      signals.push({
        type: 'full_year_funding',
        description: 'All appropriations bills enacted',
        strength: 'strong',
        timestamp: Date.now(),
      });
    } else if (enactedPct >= 0.5) {
      signals.push({
        type: 'partial_funding',
        description: `${this.state.appropriationsBillsEnacted}/${this.state.appropriationsBillsTotal} appropriations enacted`,
        strength: 'moderate',
        timestamp: Date.now(),
      });
    }

    // Price-based signals
    if (currentPrice > 0.8) {
      signals.push({
        type: 'market_expects_shutdown',
        description: `Market pricing ${(currentPrice * 100).toFixed(0)}% shutdown probability`,
        strength: currentPrice > 0.9 ? 'strong' : 'moderate',
        timestamp: Date.now(),
      });
    } else if (currentPrice < 0.2) {
      signals.push({
        type: 'market_expects_no_shutdown',
        description: `Market pricing only ${(currentPrice * 100).toFixed(0)}% shutdown probability`,
        strength: currentPrice < 0.1 ? 'strong' : 'moderate',
        timestamp: Date.now(),
      });
    }

    return {
      category: 'shutdown',
      marketId,
      question,
      phase,
      urgency,
      countdown,
      signals,
      nextKeyEvent: this.getNextKeyEvent(),
      recommendation: this.generateRecommendation(signals, currentPrice),
      lastUpdated: Date.now(),
    };
  }

  getKeyDates(): KeyEvent[] {
    const now = Date.now();
    return FUNDING_DEADLINES
      .map((d) => ({
        name: 'Funding Deadline',
        timestamp: new Date(d.date).getTime(),
        description: d.description,
        impact: 'critical' as const,
      }))
      .filter((e) => e.timestamp > now);
  }

  /**
   * Update internal state from external data
   */
  updateState(update: Partial<ShutdownState>): void {
    this.state = { ...this.state, ...update };
  }

  /**
   * Set CR expiration date
   */
  setCRExpiration(date: Date): void {
    this.state.currentFunding = 'cr';
    this.state.crExpiration = date;
    this.state.daysUntilExpiration = Math.ceil(
      (date.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );
  }

  /**
   * Record an enacted appropriations bill
   */
  recordEnactedBill(): void {
    this.state.appropriationsBillsEnacted++;
    if (this.state.appropriationsBillsEnacted >= this.state.appropriationsBillsTotal) {
      this.state.currentFunding = 'full_year';
    }
  }

  private determinePhase(): PlaybookPhase {
    if (this.state.inShutdown) return 'active';

    const daysToDeadline = this.state.daysUntilExpiration ?? this.getDaysToNextDeadline();

    if (daysToDeadline === undefined) return 'monitoring';
    if (daysToDeadline < 0) return 'active'; // Past deadline
    if (daysToDeadline <= 1) return 'imminent';
    if (daysToDeadline <= 7) return 'approaching';
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
      case 'resolution':
        return 'high';
      default:
        return 'medium';
    }
  }

  private getCountdown(): Countdown | undefined {
    const deadline = this.getNextDeadline();
    if (!deadline) return undefined;

    const now = Date.now();
    const remaining = deadline.getTime() - now;
    const days = Math.floor(remaining / (1000 * 60 * 60 * 24));
    const hours = Math.floor((remaining % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

    return {
      eventName: 'Funding Expiration',
      targetTimestamp: deadline.getTime(),
      daysRemaining: Math.max(0, days),
      hoursRemaining: Math.max(0, hours),
      isOverdue: remaining < 0,
    };
  }

  private getNextDeadline(): Date | undefined {
    if (this.state.crExpiration) {
      return this.state.crExpiration;
    }

    const now = new Date();
    for (const d of FUNDING_DEADLINES) {
      const deadline = new Date(d.date);
      if (deadline > now) return deadline;
    }

    return undefined;
  }

  private getDaysToNextDeadline(): number | undefined {
    const deadline = this.getNextDeadline();
    if (!deadline) return undefined;
    return Math.ceil((deadline.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  }

  private getNextKeyEvent(): KeyEvent | undefined {
    const events = this.getKeyDates();
    return events[0];
  }

  private generateRecommendation(
    signals: PlaybookSignal[],
    currentPrice: number
  ): PlaybookStatus['recommendation'] {
    const hasFullFunding = signals.some((s) => s.type === 'full_year_funding');
    const isActive = signals.some((s) => s.type === 'shutdown_active');
    const daysLeft = this.state.daysUntilExpiration;

    // If full-year funding passed, shutdown unlikely
    if (hasFullFunding) {
      return {
        action: currentPrice > 0.1 ? 'consider_no' : 'watch',
        confidence: 0.9,
        reasoning: 'All appropriations bills enacted - shutdown risk minimal',
        caveats: ['Unforeseen political crises could still trigger funding disputes'],
      };
    }

    // If in shutdown
    if (isActive) {
      return {
        action: currentPrice < 0.9 ? 'consider_yes' : 'watch',
        confidence: 0.85,
        reasoning: 'Shutdown currently active',
        caveats: ['Duration and resolution timing uncertain'],
      };
    }

    // If deadline imminent with no deal
    if (daysLeft !== undefined && daysLeft <= 2 && !hasFullFunding) {
      return {
        action: 'watch',
        confidence: 0.5,
        reasoning: 'Deadline imminent - high uncertainty period',
        caveats: ['Last-minute deals common', 'Price likely volatile'],
      };
    }

    return {
      action: 'watch',
      confidence: 0.3,
      reasoning: 'Monitoring situation',
      caveats: ['Watch for appropriations progress', 'Monitor Congressional news'],
    };
  }
}

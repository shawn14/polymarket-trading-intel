/**
 * Playbooks Module
 *
 * Market-specific logic for different categories of prediction markets.
 */

export { ShutdownPlaybook } from './shutdown.js';
export { HurricanePlaybook } from './hurricane.js';
export { FedDecisionPlaybook } from './fed-decision.js';
export { SportsPlaybook } from './sports.js';

export type {
  Playbook,
  PlaybookStatus,
  PlaybookPhase,
  PlaybookCategory,
  KeyEvent,
  Countdown,
  PlaybookSignal,
  Recommendation,
  ShutdownState,
  HurricaneState,
  ActiveStorm,
  WatchWarning,
  FedState,
  FOMCMeeting,
  RateExpectation,
  SportsGameState,
} from './types.js';

import { ShutdownPlaybook } from './shutdown.js';
import { HurricanePlaybook } from './hurricane.js';
import { FedDecisionPlaybook } from './fed-decision.js';
import { SportsPlaybook } from './sports.js';
import type { Playbook } from './types.js';

/**
 * Get all available playbooks
 */
export function getAllPlaybooks(): Playbook[] {
  return [
    new ShutdownPlaybook(),
    new HurricanePlaybook(),
    new FedDecisionPlaybook(),
    new SportsPlaybook(),
  ];
}

/**
 * Find matching playbook for a market question
 */
export function findPlaybook(question: string, description: string = ''): Playbook | undefined {
  const playbooks = getAllPlaybooks();
  return playbooks.find((p) => p.matches(question, description));
}

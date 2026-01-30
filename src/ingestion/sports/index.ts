/**
 * Sports Ingestion Module
 *
 * Monitors official injury reports and lineup confirmations.
 */

export { SportsClient, type SportsClientEvents } from './client.js';
export type {
  SportsEvent,
  SportsClientConfig,
  SportsLeague,
  InjuryReport,
  InjuryStatus,
  LineupConfirmation,
  GameStatus,
  PlayerInfo,
} from './types.js';
export { STAR_PLAYERS, ESPN_ENDPOINTS } from './types.js';

/**
 * API Module
 *
 * REST API for the trading intelligence system.
 */

export { APIServer, type APIServerConfig, type APIServerDependencies } from './server.js';
export type {
  SystemStatus,
  MarketSummary,
  AlertSummary,
  PlaybookAnalysis,
  KeyDatesResponse,
  HealthResponse,
  ErrorResponse,
} from './types.js';

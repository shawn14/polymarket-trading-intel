/**
 * Congress.gov API Types
 */

// Bill types
export type BillType = 'hr' | 's' | 'hjres' | 'sjres' | 'hconres' | 'sconres' | 'hres' | 'sres';

// Action types from Congress.gov
export type ActionType =
  | 'IntroReferral'
  | 'Committee'
  | 'Calendars'
  | 'Floor'
  | 'ResolvingDifferences'
  | 'President'
  | 'BecameLaw'
  | 'Veto'
  | 'Discharge'
  | 'NotUsed';

// Source system for actions
export interface SourceSystem {
  code: number;
  name: string;
}

// Single action on a bill
export interface BillAction {
  actionDate: string;
  actionTime?: string;
  text: string;
  type: ActionType;
  actionCode?: string;
  sourceSystem: SourceSystem;
}

// Bill summary from list endpoint
export interface BillSummary {
  congress: number;
  type: string;
  originChamber: string;
  originChamberCode: string;
  number: string;
  url: string;
  title: string;
  latestAction: {
    actionDate: string;
    text: string;
  };
  updateDate: string;
  updateDateIncludingText: string;
}

// Detailed bill information
export interface Bill {
  congress: number;
  type: string;
  originChamber: string;
  originChamberCode: string;
  number: string;
  title: string;
  introducedDate: string;
  updateDate: string;
  constitutionalAuthorityStatementText?: string;
  sponsors?: Array<{
    bioguideId: string;
    fullName: string;
    firstName: string;
    lastName: string;
    party: string;
    state: string;
  }>;
  latestAction: {
    actionDate: string;
    text: string;
    actionTime?: string;
  };
  actions?: {
    count: number;
    url: string;
  };
  policyArea?: {
    name: string;
  };
  subjects?: {
    count: number;
    url: string;
  };
}

// API response wrappers
export interface BillListResponse {
  bills: BillSummary[];
  pagination: {
    count: number;
    next?: string;
  };
}

export interface BillDetailResponse {
  bill: Bill;
}

export interface BillActionsResponse {
  actions: BillAction[];
  pagination: {
    count: number;
    next?: string;
  };
}

// Bill status change event
export interface BillStatusChange {
  bill: BillSummary;
  action: BillAction;
  previousAction?: BillAction;
  isNew: boolean;
  significance: 'low' | 'medium' | 'high' | 'critical';
}

// Keywords for appropriations/CR detection
export const APPROPRIATIONS_KEYWORDS = [
  'appropriation',
  'continuing resolution',
  'continuing appropriations',
  'omnibus',
  'minibus',
  'government funding',
  'fiscal year',
];

export const SHUTDOWN_RELEVANT_KEYWORDS = [
  'shutdown',
  'lapse in appropriations',
  'government funding',
  'continuing resolution',
  'CR',
  'omnibus',
  'debt ceiling',
  'debt limit',
];

// Action significance mapping
export const ACTION_SIGNIFICANCE: Record<ActionType, BillStatusChange['significance']> = {
  IntroReferral: 'low',
  Committee: 'medium',
  Calendars: 'medium',
  Floor: 'high',
  ResolvingDifferences: 'high',
  President: 'critical',
  BecameLaw: 'critical',
  Veto: 'critical',
  Discharge: 'medium',
  NotUsed: 'low',
};

// High-signal action text patterns
export const HIGH_SIGNAL_PATTERNS = [
  /passed (house|senate)/i,
  /signed by president/i,
  /became (public )?law/i,
  /vetoed/i,
  /cloture (motion|invoked)/i,
  /rule (adopted|agreed)/i,
  /enrolled/i,
  /presented to president/i,
  /conference report/i,
  /motion to proceed/i,
];

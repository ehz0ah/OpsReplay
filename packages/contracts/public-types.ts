/* Generated from public.schema.json. Run npm run contracts:generate. */

export type Plan = 'free' | 'pro';
export type Tier = 'easy' | 'medium' | 'hard';
export type Mode = 'learn' | 'challenge' | 'code_review';
export type CatalogEntry = {
  id: string;
  version: string;
  mode: Mode;
  title: string;
  summary: string;
  category: string;
  plan: Plan;
  tier?: Tier;
  language?: string;
};
export type SessionStatus = 'provisioning' | 'ready' | 'resolved' | 'failed' | 'ended' | 'abandoned' | 'error';
export type StatusReason =
  | 'validators_passed'
  | 'time_limit'
  | 'learner_ended'
  | 'heartbeat_missed'
  | 'environment_exited'
  | 'recorder_unavailable'
  | 'start_failed'
  | null;
/**
 * Recording is separate from the session outcome. An incomplete recording has no final numeric score.
 */
export type RecordingState =
  | {
      status: 'pending' | 'recording' | 'draining' | 'complete';
      reason: null;
    }
  | {
      status: 'incomplete';
      reason: 'task_lost' | 'recorder_lost' | 'drain_timeout' | 'limit_exceeded' | 'data_gap';
    };
export type TimelineEvent =
  | {
      id: string;
      at: string;
      kind: 'command';
      seq: number;
      endedAt: string | null;
      command: string;
      exitStatus: number | null;
      source: 'learner' | 'assistant';
      proposalId?: string;
      /**
       * Files observed changed in the associated capture interval. This does not attribute each change to this command.
       *
       * @maxItems 20
       */
      changedFiles: string[];
      outputExcerpt: string;
      outputTruncated: boolean;
      metrics: MetricSample | null;
    }
  | {
      id: string;
      at: string;
      kind: 'monitor';
      signal: 'recovery_sustaining' | 'recovery_lost' | 'recovered' | 'outage_started' | 'outage_ended';
      label: string;
    }
  | {
      id: string;
      at: string;
      kind: 'assistance';
      action: 'hint_released' | 'assistant_turn' | 'proposal_created' | 'proposal_run';
      refId: string;
    }
  | {
      id: string;
      at: string;
      kind: 'lifecycle';
      status: SessionStatus;
      reason: StatusReason;
    };
export type Debrief = {
  recording?: {
    status?: 'complete' | 'incomplete';
    [k: string]: unknown;
  };
  [k: string]: unknown;
} & {
  sessionId: string;
  challenge: ChallengeRef;
  attempt: Attempt;
  outcome: 'resolved' | 'failed' | 'ended' | 'abandoned' | 'error';
  rootCause: string;
  /**
   * @minItems 1
   * @maxItems 20
   */
  causalChain: string[];
  /**
   * @maxItems 20
   */
  keyEvidence: {
    id: string;
    description: string;
    /**
     * Observed means matching saved output, not proof of understanding. Not observed means no matching record, not proof the learner missed it.
     */
    status: 'observed' | 'attempted' | 'not_observed';
    commandSeq: number | null;
  }[];
  /**
   * Command-pattern and timing associations. These do not establish the cause of an outage.
   *
   * @maxItems 50
   */
  possibleHarmfulActions: {
    id: string;
    description: string;
    commandSeq: number;
    outageStartedAt: string;
  }[];
  /**
   * @maxItems 50
   */
  outages: {
    label: string;
    startedAt: string;
    endedAt: string | null;
  }[];
  /**
   * @minItems 1
   * @maxItems 20
   */
  recommendedRecovery: string[];
  /**
   * @maxItems 20
   */
  sources: Source[];
  score: ScoreComponents | null;
  assisted: boolean;
  assistance: Assistance;
  recording: RecordingState;
};
export type Playback = {
  recording?: {
    status?: 'complete' | 'incomplete';
    [k: string]: unknown;
  };
  [k: string]: unknown;
} & {
  sessionId: string;
  expiresAt: string;
  /**
   * @maxItems 500
   */
  terminal: PlaybackTrack[];
  /**
   * @maxItems 500
   */
  metrics: PlaybackTrack[];
  /**
   * @maxItems 5000
   */
  captures: {
    /**
     * Command that requested this capture, not proof of who changed each file.
     */
    commandSeq: number;
    url: string;
    baselineAt: string;
    startedAt: string;
    completedAt: string;
  }[];
  /**
   * @maxItems 200
   */
  highlights: {
    kind: 'key_evidence' | 'possible_harmful_action' | 'outage' | 'recovery';
    at: string;
    commandSeq: number | null;
    label: string;
  }[];
  recording: RecordingState;
  nextCursor: string | null;
};
/**
 * Accepted means terminal input acceptance, not successful command execution. Unknown delivery must not be resent automatically.
 */
export type ProposalStatus = 'pending' | 'dispatching' | 'accepted' | 'unknown' | 'expired';
export type Turn = {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  text: string;
  /**
   * @maxItems 1
   */
  proposals: Proposal[];
  /**
   * Fixed worker deadline. Retries never extend it.
   */
  expiresAt: string;
};
export type StreamEvent =
  | {
      type: 'turn_started';
      turnId: string;
      sequence: number;
      data: {
        requestId: string;
      };
    }
  | {
      type: 'text_delta';
      turnId: string;
      sequence: number;
      data: {
        text: string;
      };
    }
  | {
      type: 'proposal';
      turnId: string;
      sequence: number;
      data: Proposal;
    }
  | {
      type: 'turn_completed';
      turnId: string;
      sequence: number;
      data: Turn;
    }
  | {
      type: 'turn_failed';
      turnId: string;
      sequence: number;
      data: Error;
    };
export type GatewayClientMessage =
  | {
      type: 'auth';
      sessionId: string;
      ticket: string;
    }
  | {
      type: 'heartbeat';
    }
  | {
      type: 'resize';
      cols: number;
      rows: number;
    }
  | {
      type: 'run_proposal';
      proposalId: string;
    };
export type GatewayServerMessage =
  | {
      type: 'proposal_status';
      proposalId: string;
      status: ProposalStatus;
    }
  | {
      type: 'ready';
      sessionId: string;
      status: SessionStatus;
      resumed: boolean;
      replayTruncated: boolean;
    }
  | {
      type: 'metrics';
      sample: MetricSample;
      counters: Counters;
      recovery: RecoveryState;
    }
  | {
      type: 'timeline';
      event: TimelineEvent;
    }
  | {
      type: 'status';
      status: SessionStatus;
      reason: StatusReason;
    }
  | {
      type: 'error';
      code:
        | 'AUTH_FAILED'
        | 'TICKET_EXPIRED'
        | 'SESSION_NOT_READY'
        | 'SESSION_TERMINAL'
        | 'REPLACED'
        | 'TELEMETRY_UNAVAILABLE'
        | 'TERMINAL_BUSY'
        | 'PROPOSAL_UNAVAILABLE'
        | 'RATE_LIMITED'
        | 'INTERNAL_ERROR';
      message: string;
    };

/**
 * Proposed v0.2 browser-visible types for the REST API and the terminal gateway. No hidden Challenge or review answer data.
 */
export interface PublicTypes {
  Error: Error;
  Plan: Plan;
  Tier: Tier;
  Mode: Mode;
  Source: Source;
  CatalogEntry: CatalogEntry;
  CatalogFilters: CatalogFilters;
  Catalog: Catalog;
  RelatedExercise: RelatedExercise;
  LearnEntry: LearnEntry;
  Account: Account;
  StartSessionRequest: StartSessionRequest;
  MutationRequest: MutationRequest;
  ChallengeRef: ChallengeRef;
  Attempt: Attempt;
  SessionStatus: SessionStatus;
  StatusReason: StatusReason;
  Alert: Alert;
  MetricDescriptor: MetricDescriptor;
  RecoveryState: RecoveryState;
  Hint: Hint;
  Assistance: Assistance;
  SessionView: SessionView;
  SessionResponse: SessionResponse;
  SessionSummary: SessionSummary;
  SessionPage: SessionPage;
  TerminalTicket: TerminalTicket;
  MetricSample: MetricSample;
  Counters: Counters;
  TimelineEvent: TimelineEvent;
  TimelinePage: TimelinePage;
  ScoreComponents: ScoreComponents;
  Debrief: Debrief;
  PlaybackTrack: PlaybackTrack;
  Playback: Playback;
  HintResponse: HintResponse;
  MessageRequest: MessageRequest;
  ProposalStatus: ProposalStatus;
  Proposal: Proposal;
  Turn: Turn;
  StreamEvent: StreamEvent;
  DiffLine: DiffLine;
  DiffFile: DiffFile;
  ReviewExercise: ReviewExercise;
  Flag: Flag;
  ReviewSubmitRequest: ReviewSubmitRequest;
  ReviewFinding: ReviewFinding;
  ReviewSubmission: ReviewSubmission;
  ReviewSubmissionSummary: ReviewSubmissionSummary;
  ReviewSubmissionPage: ReviewSubmissionPage;
  GatewayClientMessage: GatewayClientMessage;
  GatewayServerMessage: GatewayServerMessage;
  RecordingState: RecordingState;
  EndSessionResponse: EndSessionResponse;
  PlaybackMetrics: PlaybackMetrics;
  PlaybackCapture: PlaybackCapture;
}
export interface Error {
  code:
    | 'INVALID_REQUEST'
    | 'INVALID_CURSOR'
    | 'UNAUTHENTICATED'
    | 'ACCESS_DENIED'
    | 'NOT_FOUND'
    | 'IDEMPOTENCY_CONFLICT'
    | 'VERSION_UNAVAILABLE'
    | 'ACTIVE_SESSION_EXISTS'
    | 'SESSION_NOT_READY'
    | 'SESSION_ACTIVE'
    | 'SESSION_TERMINAL'
    | 'DEBRIEF_PENDING'
    | 'PLAYBACK_PENDING'
    | 'RECORDING_EXPIRED'
    | 'CAPACITY_UNAVAILABLE'
    | 'HINT_NOT_AVAILABLE'
    | 'NO_HINTS_REMAINING'
    | 'TURN_IN_PROGRESS'
    | 'LIMIT_EXCEEDED'
    | 'PROVIDER_FAILED'
    | 'INTERNAL_ERROR'
    | 'TURN_INTERRUPTED';
  message: string;
  requestId: string;
  activeSessionId?: string;
  retryAfterSeconds?: number;
}
export interface Source {
  title: string;
  url: string;
}
export interface CatalogFilters {
  /**
   * @maxItems 3
   */
  modes: Mode[];
  /**
   * @maxItems 3
   */
  tiers: Tier[];
  /**
   * @maxItems 100
   */
  categories: string[];
  /**
   * @maxItems 100
   */
  languages: string[];
  /**
   * @maxItems 2
   */
  plans: Plan[];
}
export interface Catalog {
  /**
   * @maxItems 100
   */
  items: CatalogEntry[];
  nextCursor: string | null;
  availableFilters: CatalogFilters;
}
export interface RelatedExercise {
  mode: 'challenge' | 'code_review';
  id: string;
  title: string;
}
export interface LearnEntry {
  id: string;
  version: string;
  title: string;
  category: string;
  plan: Plan;
  summary: string;
  /**
   * @minItems 1
   * @maxItems 20
   */
  lessons: string[];
  /**
   * @minItems 1
   * @maxItems 20
   */
  sources: Source[];
  /**
   * @maxItems 20
   */
  relatedExercises: RelatedExercise[];
  html: string;
}
export interface Account {
  plan: Plan;
  planSource: 'default' | 'grant' | 'institution';
  planExpiresAt: string | null;
  activeSessionId: string | null;
}
export interface StartSessionRequest {
  requestId: string;
  challengeId: string;
  challengeVersion: string;
}
export interface MutationRequest {
  requestId: string;
}
export interface ChallengeRef {
  id: string;
  version: string;
  title: string;
  tier: Tier;
  category: string;
}
export interface Attempt {
  kind: 'first' | 'retry';
  number: number;
}
export interface Alert {
  title: string;
  summary: string;
  severity: 'warning' | 'critical';
}
export interface MetricDescriptor {
  id: string;
  label: string;
  unit: 'requests_per_second' | 'percent' | 'milliseconds' | 'mebibytes';
}
export interface RecoveryState {
  state: 'failing' | 'sustaining' | 'met';
  sustainedSeconds: number;
  requiredSeconds: number;
}
export interface Hint {
  id: string;
  text: string;
  releasedAt: string;
}
export interface Assistance {
  hintsReleased: number;
  assistantTurns: number;
  proposalsRun: number;
}
export interface SessionView {
  id: string;
  challenge: ChallengeRef;
  attempt: Attempt;
  status: SessionStatus;
  statusReason: StatusReason;
  alert: Alert;
  /**
   * @minItems 1
   * @maxItems 12
   */
  dashboard: MetricDescriptor[];
  recovery: RecoveryState | null;
  timeLimitSeconds: number;
  createdAt: string;
  readyAt: string | null;
  endsAt: string | null;
  endedAt: string | null;
  hints: {
    /**
     * @maxItems 20
     */
    released: Hint[];
    remaining: number;
    nextAvailableAt: string | null;
  };
  assistance: Assistance;
  debriefAvailable: boolean;
  recording: RecordingState;
}
export interface SessionResponse {
  session: SessionView;
  replayed: boolean;
}
export interface SessionSummary {
  id: string;
  challenge: ChallengeRef;
  attempt: Attempt;
  status: SessionStatus;
  createdAt: string;
  endedAt: string | null;
}
export interface SessionPage {
  /**
   * @maxItems 100
   */
  items: SessionSummary[];
  nextCursor: string | null;
}
export interface TerminalTicket {
  sessionId: string;
  ticket: string;
  url: string;
  expiresAt: string;
}
export interface MetricSample {
  at: string;
  values: {
    [k: string]: number;
  };
}
export interface Counters {
  totalRequests: number;
  failedRequests: number;
}
export interface TimelinePage {
  /**
   * @maxItems 100
   */
  items: TimelineEvent[];
  nextCursor: string | null;
}
export interface ScoreComponents {
  timeToRecoverySeconds: number | null;
  totalRequests: number;
  failedRequests: number;
  commandCount: number;
  observedOutages: number;
  outageSeconds: number;
}
export interface PlaybackTrack {
  url: string;
  startedAt: string;
  endedAt: string;
}
export interface HintResponse {
  hint: Hint;
  remaining: number;
  replayed: boolean;
}
export interface MessageRequest {
  requestId: string;
  text: string;
}
export interface Proposal {
  id: string;
  command: string;
  rationale: string;
  caution: boolean;
  status: ProposalStatus;
  expiresAt: string;
}
export interface DiffLine {
  kind: 'context' | 'added' | 'removed';
  oldLine: number | null;
  newLine: number | null;
  text: string;
}
export interface DiffFile {
  path: string;
  /**
   * @minItems 1
   * @maxItems 2000
   */
  lines: DiffLine[];
}
export interface ReviewExercise {
  id: string;
  version: string;
  title: string;
  tier: Tier;
  category: string;
  plan: Plan;
  language: string;
  context: string;
  /**
   * @minItems 1
   * @maxItems 20
   */
  files: DiffFile[];
}
export interface Flag {
  file: string;
  side: 'old' | 'new';
  line: number;
  concern: string;
}
export interface ReviewSubmitRequest {
  requestId: string;
  exerciseVersion: string;
  /**
   * @maxItems 50
   */
  flags: Flag[];
}
export interface ReviewFinding {
  id: string;
  title: string;
  explanation: string;
  file: string;
  side: 'old' | 'new';
  startLine: number;
  endLine: number;
  found: boolean;
  /**
   * @maxItems 50
   */
  matchedFlags: number[];
}
export interface ReviewSubmission {
  id: string;
  exerciseId: string;
  exerciseVersion: string;
  submittedAt: string;
  answerInformed: boolean;
  replayed: boolean;
  /**
   * @maxItems 50
   */
  flags: Flag[];
  /**
   * @minItems 1
   * @maxItems 50
   */
  findings: ReviewFinding[];
  /**
   * @maxItems 50
   */
  unmatchedFlags: number[];
  summary: {
    found: number;
    missed: number;
  };
}
export interface ReviewSubmissionSummary {
  id: string;
  exerciseId: string;
  exerciseVersion: string;
  submittedAt: string;
  answerInformed: boolean;
  found: number;
  missed: number;
}
export interface ReviewSubmissionPage {
  /**
   * @maxItems 100
   */
  items: ReviewSubmissionSummary[];
  nextCursor: string | null;
}
export interface EndSessionResponse {
  session: SessionView;
}
export interface PlaybackMetrics {
  schemaVersion: 1;
  kind: 'playback_metrics';
  /**
   * @maxItems 10000
   */
  frames: {
    source: string;
    sequence: number;
    recordedAt: string;
    payload: GatewayServerMessage;
  }[];
  final?: GatewayServerMessage;
}
export interface PlaybackCapture {
  schemaVersion: 1;
  commandId: string;
  commandSeq: number;
  sequence: number;
  baselineAt: string;
  startedAt: string;
  completedAt: string;
  /**
   * @maxItems 20
   */
  files: {
    path: string;
    before: string | null;
    after: string | null;
  }[];
  /**
   * @maxItems 20
   */
  logs: {
    path: string;
    /**
     * @maxItems 200
     */
    lines: string[];
  }[];
  metrics: MetricSample | null;
  incomplete: boolean;
  unavailable: boolean;
}

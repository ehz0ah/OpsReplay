/* Generated from JSON Schema by npm run contracts:generate. Do not edit. */

export type Command =
  | {
      tool: 'get_metric';
      arguments: {
        service: string;
        metric: string;
        windowTicks: number;
      };
    }
  | {
      tool: 'query_logs';
      arguments: {
        service: string;
        windowTicks: number;
        severity?: 'info' | 'warning' | 'error';
        contains?: string;
      };
    }
  | {
      tool: 'list_deployments';
      arguments: {
        service: string;
        windowTicks: number;
      };
    }
  | {
      tool: 'inspect_diff';
      arguments: {
        deploymentId: string;
      };
    }
  | {
      tool: 'read_runbook';
      arguments: {
        runbookId: string;
      };
    }
  | {
      tool: 'view_architecture';
      arguments: {
        scope: string;
      };
    }
  | {
      tool: 'get_service_status';
      arguments: {
        service: string;
      };
    }
  | {
      tool: 'rollback_deployment';
      arguments: {
        service: string;
        targetVersion: string;
      };
    }
  | {
      tool: 'scale_service';
      arguments: {
        service: string;
        instances: number;
      };
    }
  | {
      tool: 'restart_service';
      arguments: {
        service: string;
      };
    }
  | {
      tool: 'advance_time';
      arguments: {
        ticks: number;
      };
    };
export type ActionRequest =
  | {
      requestId: string;
      expectedVersion: number;
      source: 'direct';
      command: Command;
    }
  | {
      requestId: string;
      expectedVersion: number;
      source: 'llm_confirmed';
      proposalId: string;
      command: Command;
    };
export type Evidence =
  | {
      id: string;
      observationId: string;
      kind: 'alert';
      observedTick: number;
      observedVersion: number;
      title: string;
      data: {
        service: string;
        errorPercent: number;
        message: string;
      };
    }
  | {
      id: string;
      observationId: string;
      kind: 'metric';
      observedTick: number;
      observedVersion: number;
      title: string;
      data: {
        service: string;
        metric: string;
        unit: string;
        /**
         * @maxItems 100
         */
        samples: MetricSample[];
      };
    }
  | {
      id: string;
      observationId: string;
      kind: 'logs';
      observedTick: number;
      observedVersion: number;
      title: string;
      data: {
        service: string;
        /**
         * @maxItems 100
         */
        entries: LogEntry[];
      };
    }
  | {
      id: string;
      observationId: string;
      kind: 'deployments';
      observedTick: number;
      observedVersion: number;
      title: string;
      data: {
        service: string;
        /**
         * @maxItems 100
         */
        deployments: Deployment[];
      };
    }
  | {
      id: string;
      observationId: string;
      kind: 'diff';
      observedTick: number;
      observedVersion: number;
      title: string;
      data: {
        deploymentId: string;
        language: string;
        /**
         * @maxItems 1000
         */
        lines: DiffLine[];
      };
    }
  | {
      id: string;
      observationId: string;
      kind: 'runbook';
      observedTick: number;
      observedVersion: number;
      title: string;
      data: {
        /**
         * @maxItems 100
         */
        steps: string[];
      };
    }
  | {
      id: string;
      observationId: string;
      kind: 'architecture';
      observedTick: number;
      observedVersion: number;
      title: string;
      data: {
        /**
         * @maxItems 30
         */
        services: string[];
        /**
         * @maxItems 100
         */
        dependencies: Dependency[];
      };
    }
  | {
      id: string;
      observationId: string;
      kind: 'status';
      observedTick: number;
      observedVersion: number;
      title: string;
      data: {
        service: string;
        /**
         * @maxItems 100
         */
        metrics: Metric[];
      };
    };
export type SessionView = {
  id: string;
  contentId: string;
  contentVersion: string;
  engineVersion: string;
  version: number;
  tick: number;
  tickSeconds: number;
  status: 'active' | 'resolved' | 'failed' | 'ended';
  mode: 'first_attempt' | 'replay';
  informedPractice: boolean;
  /**
   * @maxItems 100
   */
  visibleMetrics: Metric[];
  /**
   * @maxItems 500
   */
  revealedEvidence: Evidence[];
  costs: Costs;
  /**
   * @maxItems 10
   */
  checkpoints: CheckpointSummary[];
  /**
   * @maxItems 100
   */
  availableOperations: OperationOffer[];
  replayOrigin: null | ReplayOrigin;
};
export type CatalogEntry = {
  id: string;
  version: string;
  title: string;
  mode: 'learn' | 'challenge' | 'code_review';
  access: 'free' | 'practice';
  difficulty?: 'easy' | 'medium' | 'hard';
  domain: string;
  language?: string;
};
export type StreamEvent =
  | {
      type: 'turn_started';
      turnId: string;
      sequence: number;
      sessionVersion: number;
      data: {
        requestId: string;
      };
    }
  | {
      type: 'text_delta';
      turnId: string;
      sequence: number;
      sessionVersion: number;
      data: {
        text: string;
      };
    }
  | {
      type: 'action_result';
      turnId: string;
      sequence: number;
      sessionVersion: number;
      data: ActionResponse;
    }
  | {
      type: 'proposal';
      turnId: string;
      sequence: number;
      sessionVersion: number;
      data: Proposal;
    }
  | {
      type: 'turn_completed';
      turnId: string;
      sequence: number;
      sessionVersion: number;
      data: Turn;
    }
  | {
      type: 'turn_failed';
      turnId: string;
      sequence: number;
      sessionVersion: number;
      data: Error;
    };

export interface PublicTypes {
  Command: Command;
  ActionRequest: ActionRequest;
  Metric: Metric;
  Evidence: Evidence;
  CheckpointSummary: CheckpointSummary;
  Costs: Costs;
  SessionView: SessionView;
  LogicalEvent: LogicalEvent;
  ActionResponse: ActionResponse;
  Error: Error;
  Source: Source;
  CatalogEntry: CatalogEntry;
  Catalog: Catalog;
  LearnEntry: LearnEntry;
  StartSessionRequest: StartSessionRequest;
  SessionResponse: SessionResponse;
  VersionedRequest: VersionedRequest;
  ReplayRequest: ReplayRequest;
  EventPage: EventPage;
  Debrief: Debrief;
  ComparisonPath: ComparisonPath;
  Comparison: Comparison;
  MessageRequest: MessageRequest;
  Proposal: Proposal;
  Turn: Turn;
  StreamEvent: StreamEvent;
  DiffLine: DiffLine;
  ReviewExercise: ReviewExercise;
  Concern: Concern;
  ReviewSubmitRequest: ReviewSubmitRequest;
  ReviewSubmission: ReviewSubmission;
  OperationOffer: OperationOffer;
  MetricSample: MetricSample;
  LogEntry: LogEntry;
  Deployment: Deployment;
  Dependency: Dependency;
  CatalogQueryFilters: CatalogQueryFilters;
  SessionSummary: SessionSummary;
  SessionPage: SessionPage;
  ReviewSubmissionPage: ReviewSubmissionPage;
  ReplayOrigin: ReplayOrigin;
}
export interface Metric {
  service: string;
  metric: string;
  value: number;
  unit: string;
}
export interface MetricSample {
  tick: number;
  value: number;
}
export interface LogEntry {
  tick: number;
  service: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
}
export interface Deployment {
  id: string;
  version: string;
  previousVersion: string;
  tick: number;
}
export interface DiffLine {
  id: string;
  file: string;
  line: number;
  kind: 'context' | 'added' | 'removed';
  text: string;
}
export interface Dependency {
  from: string;
  to: string;
}
export interface CheckpointSummary {
  id: string;
  tick: number;
  label: string;
}
export interface Costs {
  elapsedTicks: number;
  investigationTicks: number;
  impactUnits: number;
}
export interface OperationOffer {
  id: string;
  tool:
    | 'get_metric'
    | 'query_logs'
    | 'list_deployments'
    | 'inspect_diff'
    | 'read_runbook'
    | 'view_architecture'
    | 'get_service_status'
    | 'rollback_deployment'
    | 'scale_service'
    | 'restart_service'
    | 'advance_time';
  label: string;
  argumentSchema: {
    [k: string]: unknown;
  };
  costTicks: number;
  costFromArgument: 'ticks' | null;
  requiresConfirmation: boolean;
}
export interface ReplayOrigin {
  parentSessionId: string;
  checkpointId: string;
  checkpointTick: number;
}
export interface LogicalEvent {
  sequence: number;
  tick: number;
  kind:
    | 'session_started'
    | 'action_started'
    | 'observation'
    | 'incident_event'
    | 'action_completed'
    | 'incident_resolved'
    | 'incident_failed'
    | 'session_ended'
    | 'replay_started';
  message: string;
  /**
   * @maxItems 100
   */
  evidenceIds: string[];
  /**
   * @maxItems 100
   */
  observations: Evidence[];
}
export interface ActionResponse {
  requestId: string;
  replayed: boolean;
  session: SessionView;
  output: {
    summary: string;
    /**
     * @maxItems 100
     */
    evidence: Evidence[];
  };
  /**
   * @maxItems 100
   */
  events: LogicalEvent[];
  executedVersion: number;
}
export interface Error {
  code:
    | 'INVALID_REQUEST'
    | 'UNAUTHENTICATED'
    | 'ACCESS_DENIED'
    | 'NOT_FOUND'
    | 'VERSION_CONFLICT'
    | 'IDEMPOTENCY_CONFLICT'
    | 'ACTION_UNAVAILABLE'
    | 'PREREQUISITE_FAILED'
    | 'SESSION_TERMINAL'
    | 'REPLAY_UNAVAILABLE'
    | 'LIMIT_EXCEEDED'
    | 'PROVIDER_FAILED'
    | 'INTERNAL_ERROR';
  message: string;
  requestId: string;
  currentVersion?: number;
}
export interface Source {
  title: string;
  url: string;
}
export interface Catalog {
  /**
   * @maxItems 100
   */
  items: CatalogEntry[];
  nextCursor: string | null;
  /**
   * @maxItems 100
   */
  availableLanguages: string[];
  availableFilters: CatalogQueryFilters;
}
export interface CatalogQueryFilters {
  /**
   * @maxItems 3
   */
  modes: ('learn' | 'challenge' | 'code_review')[];
  /**
   * @maxItems 3
   */
  difficulties: ('easy' | 'medium' | 'hard')[];
  /**
   * @maxItems 100
   */
  domains: string[];
}
export interface LearnEntry {
  id: string;
  version: string;
  title: string;
  summary: string;
  /**
   * @maxItems 100
   */
  lessons: string[];
  /**
   * @maxItems 100
   */
  sources: Source[];
}
export interface StartSessionRequest {
  requestId: string;
  contentId: string;
  contentVersion: string;
}
export interface SessionResponse {
  requestId: string;
  replayed: boolean;
  session: SessionView;
}
export interface VersionedRequest {
  requestId: string;
  expectedVersion: number;
}
export interface ReplayRequest {
  requestId: string;
  expectedVersion: number;
  checkpointId: string;
}
export interface EventPage {
  /**
   * @maxItems 100
   */
  items: LogicalEvent[];
  nextCursor: string | null;
}
export interface Debrief {
  sessionId: string;
  rootCause: string;
  /**
   * @maxItems 100
   */
  causalChain: string[];
  /**
   * @maxItems 100
   */
  foundEvidence: string[];
  /**
   * @maxItems 100
   */
  missedEvidence: string[];
  /**
   * @maxItems 100
   */
  actionFeedback: string[];
  /**
   * @maxItems 100
   */
  recommendedPath: string[];
  /**
   * @maxItems 100
   */
  sources: Source[];
  costs: Costs;
  /**
   * @maxItems 10
   */
  checkpoints: CheckpointSummary[];
}
export interface ComparisonPath {
  sessionId: string;
  status: 'active' | 'resolved' | 'failed' | 'ended';
  observedTicks: number;
  recoveryTicks: number | null;
  impactUnits: number;
}
export interface Comparison {
  checkpointId: string;
  checkpointTick: number;
  informedPractice: true;
  original: ComparisonPath;
  replay: ComparisonPath;
  /**
   * @maxItems 100
   */
  explanations: string[];
}
export interface MessageRequest {
  requestId: string;
  expectedVersion: number;
  text: string;
}
export interface Proposal {
  id: string;
  expectedVersion: number;
  command: Command;
  expiresAt: string;
}
export interface Turn {
  id: string;
  requestId: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  inputVersion: number;
  text: string;
  /**
   * @maxItems 3
   */
  actionResults: ActionResponse[];
  /**
   * @maxItems 3
   */
  proposals: Proposal[];
}
export interface ReviewExercise {
  id: string;
  version: string;
  title: string;
  difficulty: 'easy' | 'medium' | 'hard';
  language: string;
  context: string;
  /**
   * @maxItems 1000
   */
  lines: DiffLine[];
}
export interface Concern {
  lineId: string;
  text: string;
}
export interface ReviewSubmitRequest {
  requestId: string;
  contentVersion: string;
  /**
   * @maxItems 100
   */
  concerns: Concern[];
}
export interface ReviewSubmission {
  id: string;
  exerciseId: string;
  contentVersion: string;
  replayed: boolean;
  informedPractice: boolean;
  /**
   * @maxItems 100
   */
  concerns: Concern[];
  /**
   * @maxItems 100
   */
  findings: Concern[];
}
export interface SessionSummary {
  id: string;
  contentId: string;
  contentVersion: string;
  status: 'active' | 'resolved' | 'failed' | 'ended';
  mode: 'first_attempt' | 'replay';
  createdAt: string;
  updatedAt: string;
}
export interface SessionPage {
  /**
   * @maxItems 100
   */
  items: SessionSummary[];
  nextCursor: string | null;
}
export interface ReviewSubmissionPage {
  /**
   * @maxItems 100
   */
  items: ReviewSubmission[];
  nextCursor: string | null;
}

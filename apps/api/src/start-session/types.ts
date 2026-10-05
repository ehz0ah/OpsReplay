export interface StartRequest {
  requestId: string;
  challengeId: string;
  challengeVersion: string;
}

export type PlanName = 'free' | 'pro';
export interface ChallengeRef {
  id: string;
  version: string;
  title: string;
  tier: 'easy' | 'medium' | 'hard';
  category: string;
}
export interface Alert {
  title: string;
  summary: string;
  severity: 'warning' | 'critical';
}
export interface Metric {
  id: string;
  label: string;
  unit: 'requests_per_second' | 'percent' | 'milliseconds' | 'mebibytes';
}
export interface SessionView {
  id: string;
  challenge: ChallengeRef;
  attempt: { kind: 'first' | 'retry'; number: number };
  status: 'provisioning' | 'ready' | 'resolved' | 'failed' | 'ended' | 'abandoned' | 'error';
  statusReason: 'validators_passed' | 'time_limit' | 'learner_ended' | 'heartbeat_missed' | 'environment_exited' | 'start_failed' | null;
  alert: Alert;
  dashboard: Metric[];
  recovery: { state: 'failing' | 'sustaining' | 'met'; sustainedSeconds: number; requiredSeconds: number } | null;
  timeLimitSeconds: number;
  createdAt: string;
  readyAt: string | null;
  endsAt: string | null;
  endedAt: string | null;
  hints: { released: { id: string; text: string; releasedAt: string }[]; remaining: number; nextAvailableAt: string | null };
  assistance: { hintsReleased: number; assistantTurns: number; proposalsRun: number };
  debriefAvailable: boolean;
  recording: { status: 'pending' | 'recording' | 'draining' | 'complete' | 'incomplete'; reason: string | null };
}

// Publication supplies this small admission snapshot, not a private Challenge manifest.
export interface ContentVersion {
  mode: 'challenge';
  status: 'draft' | 'published' | 'retired';
  plan: PlanName;
  challenge: ChallengeRef;
  alert: Alert;
  dashboard: Metric[];
  hintCount: number;
  timeLimits: { free: number; pro: number | null };
  pins: { taskDefinitionArn: string; challengeImageDigest: string; monitorImageDigest: string };
}
export interface Plan {
  plan: PlanName;
  expiresAt: string | null;
}
export interface Progress {
  // Only finalised, non-error attempts count. Platform failures preserve the first attempt.
  completedAttempts: number;
}

export interface LaunchConfiguration {
  clusterArn: string;
  subnetIds: string[];
  securityGroupIds: string[];
  platformVersion: string;
  monitorContainerName: string;
}

export interface EcsLaunchArguments {
  cluster: string;
  taskDefinition: string;
  clientToken: string;
  startedBy: string;
  count: 1;
  enableExecuteCommand: false;
  launchType: 'FARGATE';
  platformVersion: string;
  networkConfiguration: {
    awsvpcConfiguration: {
      subnets: string[];
      securityGroups: string[];
      assignPublicIp: 'DISABLED';
    };
  };
  overrides: {
    containerOverrides: [{
      name: string;
      environment: [
        { name: 'OPSREPLAY_SESSION_ID'; value: string },
        { name: 'OPSREPLAY_MONITOR_SECRET'; value: string },
      ];
    }];
  };
  tags: [{ key: 'opsreplay:session-id'; value: string }];
}

export interface SessionRecord {
  ownerId: string;
  view: SessionView;
  accessGrant: { plan: PlanName; admittedAt: string; timeLimitSeconds: number };
  pins: ContentVersion['pins'];
  launchArguments: EcsLaunchArguments;
  monitorSecret: string;
  provisioningDeadline: string;
  launchRecoveryDeadline: string;
  scheduleName: string;
  taskArn: string | null;
  provisioningCleanup: { status: 'pending' | 'complete'; completedAt: string | null };
}
export interface Receipt {
  ownerId: string;
  requestId: string;
  hash: string;
  sessionId: string;
}
export interface ActiveLock {
  sessionId: string;
  requestId: string;
}
export interface Snapshot {
  content: ContentVersion | undefined;
  plan: Plan | undefined;
  progress: Progress | undefined;
}
export interface Admission {
  request: StartRequest;
  receipt: Receipt;
  session: SessionRecord;
  snapshot: Snapshot;
}

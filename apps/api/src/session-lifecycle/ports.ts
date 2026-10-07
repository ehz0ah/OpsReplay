import type { EcsLaunchArguments, LaunchFailure, SessionRecord } from '../start-session/types.js';

export interface LifecycleStorePort {
  session(id: string, abortSignal?: AbortSignal): Promise<SessionRecord | undefined>;
  saveMonitorCertificate(id: string, certificate: string, abortSignal?: AbortSignal): Promise<SessionRecord>;
  saveTask(id: string, taskArn: string, abortSignal?: AbortSignal): Promise<SessionRecord>;
  publishRecordingWork(
    id: string,
    taskArn: string,
    taskAddress: string,
    observedAt: string,
    abortSignal?: AbortSignal,
  ): Promise<SessionRecord>;
  failStartWithoutTask(
    id: string,
    endedAt: string,
    failure: LaunchFailure,
    abortSignal?: AbortSignal,
  ): Promise<SessionRecord>;
  markStartFailed(id: string, endedAt: string, abortSignal?: AbortSignal): Promise<SessionRecord>;
  completeStartFailure(id: string, completedAt: string, abortSignal?: AbortSignal): Promise<SessionRecord>;
}

export interface ProvisioningSchedulePort {
  ensure(session: SessionRecord, now: Date, abortSignal?: AbortSignal): Promise<void>;
}

export interface MonitorBootstrapPort {
  ensure(session: SessionRecord, abortSignal?: AbortSignal): Promise<string>;
}

export interface EnvironmentTask {
  taskArn: string;
  lastStatus: string | undefined;
}

export interface EnvironmentPort {
  launch(arguments_: EcsLaunchArguments, abortSignal?: AbortSignal): Promise<string>;
  findActive(cluster: string, startedBy: string, abortSignal?: AbortSignal): Promise<EnvironmentTask[]>;
  describe(cluster: string, taskArn: string, abortSignal?: AbortSignal): Promise<EnvironmentTask | undefined>;
  stop(cluster: string, taskArn: string, reason: string, abortSignal?: AbortSignal): Promise<void>;
}

export class LaunchRejectedError extends Error {
  constructor(readonly failure: LaunchFailure) {
    super('ECS rejected the task launch');
  }
}

export class CleanupPendingError extends Error {
  constructor() {
    super('Provisioning cleanup is not yet confirmed');
  }
}

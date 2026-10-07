import { randomUUID } from 'node:crypto';
import { createGatewayAwsClients, type GatewayAwsClients } from './aws.js';
import {
  createGatewayRecordingSupervisor,
  type GatewayRecordingServiceClients,
  type GatewayRecordingServiceOptions,
} from './recording-service.js';
import type { MonitorRecordingSupervisorEvent } from './monitor-recording-supervisor.js';

export interface GatewayRecordingRuntimeConfiguration {
  sessionTableName: string;
  recordingBucketName: string;
  maximumConcurrentRecordings: number;
  monitorPort: number;
}

export type GatewayRecordingRuntimeEvent =
  | { type: 'service_started'; recorderId: string; maximumConcurrentRecordings: number }
  | { type: 'service_stopped'; recorderId: string }
  | MonitorRecordingSupervisorEvent;

interface RecordingSupervisor {
  run(signal: AbortSignal): Promise<void>;
}

export interface GatewayRecordingRuntimeDependencies {
  createClients: () => GatewayAwsClients;
  createSupervisor: (
    options: GatewayRecordingServiceOptions,
    clients: GatewayRecordingServiceClients,
  ) => RecordingSupervisor;
  createRecorderId: () => string;
  report: (event: GatewayRecordingRuntimeEvent) => void;
}

const tableNamePattern = /^[A-Za-z0-9_.-]{3,255}$/;
const bucketPattern = /^(?=.{3,63}$)(?![0-9]+(?:\.[0-9]+){3}$)(?!.*\.\.)(?!.*\.-)(?!.*-\.)[a-z0-9][a-z0-9.-]*[a-z0-9]$/;

export function createGatewayRecorderId(): string {
  return `gateway-${randomUUID()}`;
}

function integer(environment: NodeJS.ProcessEnv, name: string, minimum: number, maximum: number): number {
  const raw = environment[name];
  if (!raw || !/^(?:0|[1-9][0-9]*)$/.test(raw)) throw new Error(`${name} is invalid`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} is invalid`);
  return value;
}

function identifier(environment: NodeJS.ProcessEnv, name: string, pattern: RegExp): string {
  const value = environment[name];
  if (!value || !pattern.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

export function loadGatewayRecordingRuntimeConfiguration(
  environment: NodeJS.ProcessEnv,
): GatewayRecordingRuntimeConfiguration {
  return {
    sessionTableName: identifier(environment, 'SESSION_TABLE_NAME', tableNamePattern),
    recordingBucketName: identifier(environment, 'RECORDING_BUCKET_NAME', bucketPattern),
    maximumConcurrentRecordings: integer(environment, 'MAXIMUM_CONCURRENT_RECORDINGS', 1, 64),
    monitorPort: integer(environment, 'MONITOR_PORT', 1, 65_535),
  };
}

const defaultDependencies: GatewayRecordingRuntimeDependencies = {
  createClients: createGatewayAwsClients,
  createSupervisor: createGatewayRecordingSupervisor,
  createRecorderId: createGatewayRecorderId,
  report: (event) => console.info(JSON.stringify({ component: 'gateway_recording', ...event })),
};

function safeReport(report: GatewayRecordingRuntimeDependencies['report'], event: GatewayRecordingRuntimeEvent): void {
  try {
    report(event);
  } catch {
    /* Reporting must not change recording state. */
  }
}

export async function runGatewayRecordingRuntime(
  configuration: GatewayRecordingRuntimeConfiguration,
  signal: AbortSignal,
  dependencies: GatewayRecordingRuntimeDependencies = defaultDependencies,
): Promise<void> {
  signal.throwIfAborted();
  const recorderId = dependencies.createRecorderId();
  const clients = dependencies.createClients();
  try {
    const supervisor = dependencies.createSupervisor(
      {
        ...configuration,
        recorderId,
        report: (event) => safeReport(dependencies.report, event),
      },
      clients,
    );
    safeReport(dependencies.report, {
      type: 'service_started',
      recorderId,
      maximumConcurrentRecordings: configuration.maximumConcurrentRecordings,
    });
    await supervisor.run(signal);
  } finally {
    clients.close();
    safeReport(dependencies.report, { type: 'service_stopped', recorderId });
  }
}

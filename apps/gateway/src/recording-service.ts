import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { S3Client } from '@aws-sdk/client-s3';
import { MonitorClient } from './monitor-client.js';
import { S3MonitorChunkStore } from './monitor-chunk-store.js';
import { MonitorRecordingRunner } from './monitor-recording-runner.js';
import { MonitorRecordingSupervisor, type MonitorRecordingSupervisorEvent } from './monitor-recording-supervisor.js';
import { DynamoMonitorRecordingStore } from './monitor-recording-store.js';
import { DynamoRecordingWorkSource } from './recording-work-source.js';

export interface GatewayRecordingServiceOptions {
  sessionTableName: string;
  recordingBucketName: string;
  recorderId: string;
  maximumConcurrentRecordings: number;
  monitorPort?: number;
  pollIntervalMs?: number;
  retryDelayMs?: number;
  leaseDurationMs?: number;
  renewalIntervalMs?: number;
  monitorPollIntervalMs?: number;
  report?: (event: MonitorRecordingSupervisorEvent) => void;
}

export interface GatewayRecordingServiceClients {
  dynamo: DynamoDBDocumentClient;
  s3: S3Client;
}

const recorderIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

export function createGatewayRecordingSupervisor(
  options: GatewayRecordingServiceOptions,
  clients: GatewayRecordingServiceClients,
): MonitorRecordingSupervisor {
  const monitorPort = options.monitorPort ?? 9443;
  if (
    !recorderIdPattern.test(options.recorderId) ||
    !Number.isInteger(monitorPort) ||
    monitorPort < 1 ||
    monitorPort > 65_535
  ) {
    throw new Error('Gateway recording service configuration is invalid.');
  }
  const source = new DynamoRecordingWorkSource(clients.dynamo, options.sessionTableName, options.recorderId);
  const recordings = new DynamoMonitorRecordingStore(clients.dynamo, options.sessionTableName);
  const chunks = new S3MonitorChunkStore(clients.s3, options.recordingBucketName);
  return new MonitorRecordingSupervisor({
    source,
    maximumConcurrentRecordings: options.maximumConcurrentRecordings,
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    ...(options.report === undefined ? {} : { report: options.report }),
    createRunner: (work) =>
      new MonitorRecordingRunner({
        sessionId: work.sessionId,
        recorderId: options.recorderId,
        client: new MonitorClient({
          host: work.taskAddress,
          port: monitorPort,
          certificate: work.monitorCertificate,
          secret: work.monitorSecret,
        }),
        chunks,
        recordings,
        ...(options.leaseDurationMs === undefined ? {} : { leaseDurationMs: options.leaseDurationMs }),
        ...(options.renewalIntervalMs === undefined ? {} : { renewalIntervalMs: options.renewalIntervalMs }),
        ...(options.monitorPollIntervalMs === undefined ? {} : { pollIntervalMs: options.monitorPollIntervalMs }),
      }),
  });
}

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { S3Client } from '@aws-sdk/client-s3';
import { MonitorClient } from './monitor-client.js';
import { S3MonitorChunkStore } from './monitor-chunk-store.js';
import { MonitorRecordingRunner } from './monitor-recording-runner.js';
import { MonitorRecordingSupervisor, type MonitorRecordingSupervisorEvent } from './monitor-recording-supervisor.js';
import { DynamoMonitorRecordingStore } from './monitor-recording-store.js';
import { DynamoRecordingWorkSource } from './recording-work-source.js';
import { TerminalRecordingClient } from './terminal-recording-client.js';
import { S3TerminalChunkStore } from './terminal-chunk-store.js';
import { DynamoTerminalRecordingStore } from './terminal-recording-store.js';
import { DynamoTerminalSealingStore } from './terminal-sealing-store.js';
import { S3TerminalPageArchive } from './terminal-page-archive.js';
import { DynamoAttemptStore } from '../../../packages/session/src/attempt-store.js';

export interface GatewayRecordingServiceOptions {
  sessionTableName: string;
  recordingBucketName: string;
  recorderId: string;
  maximumConcurrentRecordings: number;
  monitorPort?: number;
  terminalPort?: number;
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
  const terminalPort = options.terminalPort ?? 7681;
  if (
    !recorderIdPattern.test(options.recorderId) ||
    !Number.isInteger(monitorPort) ||
    monitorPort < 1 ||
    monitorPort > 65_535 ||
    !Number.isInteger(terminalPort) ||
    terminalPort < 1 ||
    terminalPort > 65_535
  ) {
    throw new Error('Gateway recording service configuration is invalid.');
  }
  const source = new DynamoRecordingWorkSource(clients.dynamo, options.sessionTableName, options.recorderId);
  const recordings = new DynamoMonitorRecordingStore(clients.dynamo, options.sessionTableName);
  const chunks = new S3MonitorChunkStore(clients.s3, options.recordingBucketName);
  const terminalRecordings = new DynamoTerminalRecordingStore(clients.dynamo, options.sessionTableName);
  const terminalChunks = new S3TerminalChunkStore(clients.s3, options.recordingBucketName);
  const terminalSeals = new DynamoTerminalSealingStore(clients.dynamo, options.sessionTableName);
  const terminalPages = new S3TerminalPageArchive(clients.s3, options.recordingBucketName);
  const attempts = new DynamoAttemptStore(clients.dynamo, options.sessionTableName);
  return new MonitorRecordingSupervisor({
    source,
    maximumConcurrentRecordings: options.maximumConcurrentRecordings,
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    ...(options.report === undefined ? {} : { report: options.report }),
    createRunner: (work) => {
      const monitor = new MonitorClient({
        host: work.taskAddress,
        port: monitorPort,
        certificate: work.monitorCertificate,
        secret: work.monitorSecret,
      });
      return new MonitorRecordingRunner({
        sessionId: work.sessionId,
        recorderId: options.recorderId,
        client: monitor,
        chunks,
        recordings,
        terminal: {
          connect: async (signal) => {
            const checkpoint = await terminalRecordings.get(work.sessionId, signal);
            return TerminalRecordingClient.connect(
              {
                host: work.taskAddress,
                port: terminalPort,
                ...(checkpoint ? { expectedSource: checkpoint.metadata.source } : {}),
              },
              signal,
            );
          },
          chunks: terminalChunks,
          recordings: terminalRecordings,
          pages: terminalPages,
          seals: terminalSeals,
        },
        lifecycle: {
          ready: async (lease, startedAt, terminal, signal) => {
            const saved = await attempts.session(work.sessionId, signal);
            if (saved?.view.status === 'provisioning') {
              const initial = await attempts.observation(work.sessionId, signal);
              if (!initial || initial.recovery.state !== 'failing')
                throw new Error('Initial monitor recovery is invalid.');
              await attempts.ready(lease, startedAt, terminal, initial.recovery, new Date().toISOString(), signal);
            }
            await attempts.observe(work.sessionId, new Date().toISOString(), signal, lease);
          },
          monitor: async (lease, value, signal) => {
            if (value.frames.some((frame) => frame.payload.type === 'metrics'))
              await attempts.observe(work.sessionId, new Date().toISOString(), signal, lease);
          },
        },
        ...(options.leaseDurationMs === undefined ? {} : { leaseDurationMs: options.leaseDurationMs }),
        ...(options.renewalIntervalMs === undefined ? {} : { renewalIntervalMs: options.renewalIntervalMs }),
        ...(options.monitorPollIntervalMs === undefined ? {} : { pollIntervalMs: options.monitorPollIntervalMs }),
      });
    },
  });
}

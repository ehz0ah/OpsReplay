import type { SessionRecord } from '../src/start-session/types.js';

// A saved provisioning record. No published repository content or AWS credentials are used.
export function sessionRecord(id: string): SessionRecord {
  return {
    ownerId: '11111111-1111-4111-8111-111111111111',
    view: {
      id,
      challenge: {
        id: 'wrong-upstream-port',
        version: '0.1.2',
        title: 'Storefront returns 502',
        tier: 'easy',
        category: 'networking',
      },
      attempt: { kind: 'first', number: 1 },
      status: 'provisioning',
      statusReason: null,
      alert: { title: 'Checkout errors', summary: 'Checkout requests fail.', severity: 'critical' },
      dashboard: [{ id: 'error_rate', label: 'Errors', unit: 'percent' }],
      recovery: null,
      timeLimitSeconds: 1200,
      createdAt: '2026-10-10T07:58:00.000Z',
      readyAt: null,
      endsAt: null,
      endedAt: null,
      hints: { released: [], remaining: 2, nextAvailableAt: null },
      assistance: { hintsReleased: 0, assistantTurns: 0, proposalsRun: 0 },
      debriefAvailable: false,
      recording: { status: 'pending', reason: null },
    },
    accessGrant: { plan: 'free', admittedAt: '2026-10-10T07:58:00.000Z', timeLimitSeconds: 1200 },
    hintPlan: [
      { id: 'read-proxy-error', minElapsedMinutes: 3 },
      { id: 'compare-listeners', minElapsedMinutes: 6 },
    ],
    pins: {
      taskDefinitionArn: 'arn:aws:ecs:ap-southeast-1:123456789012:task-definition/opsreplay-test:1',
      challengeImageDigest: `sha256:${'a'.repeat(64)}`,
      monitorImageDigest: `sha256:${'b'.repeat(64)}`,
      manifestSha256: 'c'.repeat(64),
    },
    launchArguments: {
      cluster: 'arn:aws:ecs:ap-southeast-1:123456789012:cluster/opsreplay-test',
      taskDefinition: 'arn:aws:ecs:ap-southeast-1:123456789012:task-definition/opsreplay-test:1',
      clientToken: id,
      startedBy: id,
      count: 1,
      enableExecuteCommand: false,
      launchType: 'FARGATE',
      platformVersion: '1.4.0',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: ['subnet-0123456789abcdef0'],
          securityGroups: ['sg-0123456789abcdef0'],
          assignPublicIp: 'DISABLED',
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: 'monitor',
            environment: [{ name: 'OPSREPLAY_SESSION_ID', value: id }],
            environmentFiles: [{ type: 's3', value: `arn:aws:s3:::test-secrets/sessions/${id}.env` }],
          },
        ],
      },
      tags: [{ key: 'opsreplay:session-id', value: id }],
    },
    monitorSecret: 's'.repeat(43),
    monitorCertificate: null,
    launchFailure: null,
    provisioningDeadline: '2026-10-10T08:01:00.000Z',
    launchRecoveryDeadline: '2026-10-10T08:06:00.000Z',
    scheduleName: `session-${id}`,
    taskArn: null,
    taskAddress: null,
    provisioningCleanup: { status: 'pending', completedAt: null },
  };
}

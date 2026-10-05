import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import publicSchema from '../../../../packages/contracts/schemas/public.schema.json';
import type { ActiveLock, ContentVersion, Plan, Progress, Receipt, SessionRecord, SessionView, StartRequest } from './types.js';

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addSchema(publicSchema);
const ref = (name: string) => ({ $ref: `${publicSchema.$id}#/$defs/${name}` });
const uuid = { type: 'string', format: 'uuid' };
const timestamp = { type: 'string', format: 'date-time' };
const owner = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' };
const object = (properties: Record<string, unknown>, additionalProperties = false) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties,
});
const limit = { type: 'integer', minimum: 60, maximum: 14400 };
const digest = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' };
const ecsClusterArn = { type: 'string', pattern: '^arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]{12}:cluster/[A-Za-z0-9_-]+$' };
const ecsTaskArn = { type: 'string', pattern: '^arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]{12}:task/(?:[A-Za-z0-9_-]+/)?[a-f0-9-]+$' };
const subnetId = { type: 'string', pattern: '^subnet-[a-f0-9]{8,17}$' };
const securityGroupId = { type: 'string', pattern: '^sg-[a-f0-9]{8,17}$' };
const monitorSecret = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' };
const pins = object({
  taskDefinitionArn: { type: 'string', pattern: '^arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]{12}:task-definition/[A-Za-z0-9_-]+:[1-9][0-9]*$' },
  challengeImageDigest: digest,
  monitorImageDigest: digest,
});

export const validRequest = ajv.compile<StartRequest>(ref('StartSessionRequest'));
export const validView = ajv.compile<SessionView>(ref('SessionView'));
export const validOwner = ajv.compile<string>(owner);
export const validUuid = ajv.compile<string>(uuid);
export const validTaskArn = ajv.compile<string>(ecsTaskArn);
export const validContent = ajv.compile<ContentVersion>(object({
  mode: { const: 'challenge' },
  status: { enum: ['draft', 'published', 'retired'] },
  plan: ref('Plan'), challenge: ref('ChallengeRef'), alert: ref('Alert'),
  dashboard: { $ref: `${publicSchema.$id}#/$defs/SessionView/properties/dashboard` },
  hintCount: { type: 'integer', minimum: 0, maximum: 20 },
  timeLimits: object({ free: limit, pro: { anyOf: [limit, { type: 'null' }] } }),
  pins,
}));
export type StartableContent = ContentVersion & {
  status: 'published';
  timeLimits: { free: number; pro: number };
};
export function isStartableContent(content: ContentVersion | undefined): content is StartableContent {
  return content?.status === 'published'
    && content.timeLimits.pro !== null
    && content.timeLimits.pro > content.timeLimits.free;
}
export const validPlan = ajv.compile<Plan>(object({
  plan: ref('Plan'), expiresAt: { anyOf: [timestamp, { type: 'null' }] },
}));
export const validProgress = ajv.compile<Progress>(object({
  completedAttempts: { type: 'integer', minimum: 0, maximum: 1000 },
}));
export const validReceipt = ajv.compile<Receipt>(object({
  ownerId: owner, requestId: uuid, hash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, sessionId: uuid,
}));
export const validLock = ajv.compile<ActiveLock>(object({ sessionId: uuid, requestId: uuid }));
const launchArguments = object({
  cluster: ecsClusterArn,
  taskDefinition: pins.properties.taskDefinitionArn,
  clientToken: uuid,
  startedBy: uuid,
  count: { const: 1 },
  enableExecuteCommand: { const: false },
  launchType: { const: 'FARGATE' },
  platformVersion: { type: 'string', pattern: '^[0-9]+(?:\\.[0-9]+){2}$' },
  networkConfiguration: object({
    awsvpcConfiguration: object({
      subnets: { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true, items: subnetId },
      securityGroups: { type: 'array', minItems: 1, maxItems: 5, uniqueItems: true, items: securityGroupId },
      assignPublicIp: { const: 'DISABLED' },
    }),
  }),
  overrides: object({
    containerOverrides: {
      type: 'array', minItems: 1, maxItems: 1,
      items: object({
        name: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,255}$' },
        environment: {
          type: 'array', minItems: 2, maxItems: 2,
          prefixItems: [
            object({ name: { const: 'OPSREPLAY_SESSION_ID' }, value: uuid }),
            object({ name: { const: 'OPSREPLAY_MONITOR_SECRET' }, value: monitorSecret }),
          ],
          items: false,
        },
      }),
    },
  }),
  tags: {
    type: 'array', minItems: 1, maxItems: 1,
    items: object({ key: { const: 'opsreplay:session-id' }, value: uuid }),
  },
});
// Known lifecycle fields are validated before effects. Extra private fields never reach publicView.
export const validSession = ajv.compile<SessionRecord>(object({
  ownerId: owner, view: ref('SessionView'),
  accessGrant: object({ plan: ref('Plan'), admittedAt: timestamp, timeLimitSeconds: limit }),
  pins, launchArguments, monitorSecret, provisioningDeadline: timestamp,
  launchRecoveryDeadline: timestamp,
  scheduleName: { type: 'string', pattern: '^session-[a-f0-9-]{36}$' },
  taskArn: { anyOf: [ecsTaskArn, { type: 'null' }] },
  provisioningCleanup: object({
    status: { enum: ['pending', 'complete'] },
    completedAt: { anyOf: [timestamp, { type: 'null' }] },
  }),
}, true));

export function validSessionRelations(session: SessionRecord): boolean {
  const launch = session.launchArguments;
  const environment = launch.overrides.containerOverrides[0]?.environment;
  return launch.clientToken === session.view.id
    && launch.startedBy === session.view.id
    && launch.taskDefinition === session.pins.taskDefinitionArn
    && launch.tags[0]?.value === session.view.id
    && environment?.[0]?.value === session.view.id
    && environment?.[1]?.value === session.monitorSecret
    && session.scheduleName === `session-${session.view.id}`
    && Date.parse(session.provisioningDeadline) > Date.parse(session.view.createdAt)
    && Date.parse(session.launchRecoveryDeadline) > Date.parse(session.provisioningDeadline);
}

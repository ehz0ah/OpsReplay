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
const pins = object({
  taskDefinitionArn: { type: 'string', pattern: '^arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]{12}:task-definition/[A-Za-z0-9_-]+:[1-9][0-9]*$' },
  challengeImageDigest: digest,
  monitorImageDigest: digest,
});

export const validRequest = ajv.compile<StartRequest>(ref('StartSessionRequest'));
export const validView = ajv.compile<SessionView>(ref('SessionView'));
export const validOwner = ajv.compile<string>(owner);
export const validUuid = ajv.compile<string>(uuid);
export const validContent = ajv.compile<ContentVersion>(object({
  mode: { const: 'challenge' },
  status: { enum: ['draft', 'published', 'retired'] },
  plan: ref('Plan'), challenge: ref('ChallengeRef'), alert: ref('Alert'),
  dashboard: { $ref: `${publicSchema.$id}#/$defs/SessionView/properties/dashboard` },
  hintCount: { type: 'integer', minimum: 0, maximum: 20 },
  timeLimits: object({ free: limit, pro: { anyOf: [limit, { type: 'null' }] } }),
  pins,
}));
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
// Private session fields may grow with lifecycle work. Only view is returned to callers.
export const validSession = ajv.compile<SessionRecord>(object({
  ownerId: owner, view: ref('SessionView'),
  accessGrant: object({ plan: ref('Plan'), admittedAt: timestamp, timeLimitSeconds: limit }),
  pins, provisioningDeadline: timestamp,
  scheduleName: { type: 'string', pattern: '^session-[a-f0-9-]{36}$' },
}, true));

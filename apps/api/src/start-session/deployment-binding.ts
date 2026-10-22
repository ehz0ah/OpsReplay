import Ajv2020 from 'ajv/dist/2020.js';
import type { DeploymentBinding } from './types.js';

const pins = {
  type: 'object',
  additionalProperties: false,
  required: ['taskDefinitionArn', 'challengeImageDigest', 'monitorImageDigest', 'manifestSha256'],
  properties: {
    taskDefinitionArn: {
      type: 'string',
      pattern: '^arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]{12}:task-definition/[A-Za-z0-9_-]+:[1-9][0-9]*$',
    },
    challengeImageDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
    monitorImageDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
    manifestSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  },
};

export const validDeploymentBinding = new Ajv2020({ strict: true }).compile<DeploymentBinding>({
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'contentPins', 'pins'],
  properties: { schemaVersion: { const: 1 }, contentPins: pins, pins },
});

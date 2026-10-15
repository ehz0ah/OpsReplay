import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import publicSchema from '../../../packages/contracts/schemas/public.schema.json';
import { createEndSessionHandler } from '../src/end-session/handler.js';
import { sessionRecord } from './session-fixture.js';
test('the real end handler satisfies its documented envelope without exposing private session fields', async () => {
  const record = sessionRecord(randomUUID());
  record.view.status = 'ended';
  record.view.statusReason = 'learner_ended';
  record.view.endedAt = record.view.createdAt;
  const handler = createEndSessionHandler({ store: { outcome: async () => record } });
  const result = await handler(
    {
      httpMethod: 'POST',
      resource: '/v1/sessions/{id}/end',
      pathParameters: { id: record.view.id },
      body: JSON.stringify({ requestId: randomUUID() }),
      requestContext: { authorizer: { claims: { sub: record.ownerId } } },
    } as unknown as APIGatewayProxyEvent,
    { awsRequestId: randomUUID(), getRemainingTimeInMillis: () => 10000 },
  );
  assert.equal(result.statusCode, 200);
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
  addFormats(ajv);
  ajv.addSchema(publicSchema);
  const validate = ajv.getSchema(`${publicSchema.$id}#/$defs/EndSessionResponse`)!;
  assert.ok(validate(JSON.parse(result.body)), JSON.stringify(validate.errors));
  assert.equal(result.body.includes(record.monitorSecret), false);
  assert.equal(result.body.includes('taskAddress'), false);
  assert.equal('replayed' in JSON.parse(result.body), false);
});

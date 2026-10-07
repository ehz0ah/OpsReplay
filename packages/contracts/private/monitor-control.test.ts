import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  isMonitorControlFramePage,
  isMonitorControlHealthResponse,
  isMonitorControlSealRequest,
  isMonitorControlSealResponse,
  isMonitorControlStartResponse,
  isMonitorControlTimestamp,
  monitorControlClientError,
  monitorControlErrorBody,
  monitorControlSchema,
  parseMonitorControlCursor,
} from './monitor-control.js';

const timestamp = '2026-09-28T08:42:03.123Z';
const source = '123e4567-e89b-42d3-a456-426614174000';
const payload = { type: 'metrics' };
const openapi = readFileSync(fileURLToPath(new URL('../openapi.json', import.meta.url)), 'utf8');
const validPayload = (value: unknown): value is typeof payload =>
  typeof value === 'object' && value !== null && 'type' in value && value.type === 'metrics';

test('defines the private routes and canonical boundary values once', () => {
  assert.deepEqual(monitorControlSchema.routes, {
    health: { method: 'GET', path: '/healthz', readyStatus: 200, unavailableStatus: 503 },
    start: { method: 'POST', path: '/v1/start', successStatus: 200 },
    frames: { method: 'GET', path: '/v1/frames', successStatus: 200, cursorParameter: 'after' },
    seal: { method: 'POST', path: '/v1/seal', successStatus: 200 },
  });
  assert.equal(parseMonitorControlCursor('0'), 0);
  assert.equal(parseMonitorControlCursor('999999'), 999_999);
  for (const invalid of ['', '00', '-1', '1000000', '1.0', ' 1']) {
    assert.equal(parseMonitorControlCursor(invalid), undefined, invalid);
  }
  assert.equal(isMonitorControlTimestamp(timestamp), true);
  assert.equal(isMonitorControlTimestamp('2026-09-28T08:42:03Z'), false);
  assert.equal(isMonitorControlTimestamp('2026-09-28T08:42:03.123+00:00'), false);
});

test('keeps monitor control routes out of the public OpenAPI contract', () => {
  for (const route of Object.values(monitorControlSchema.routes)) {
    assert.equal(openapi.includes(`"${route.path}"`), false, route.path);
  }
});

test('validates each successful response without accepting extra fields', () => {
  assert.equal(isMonitorControlHealthResponse({ status: 'ready' }), true);
  assert.equal(isMonitorControlHealthResponse({ status: 'ready', rootCause: 'private' }), false);
  assert.equal(isMonitorControlStartResponse({ startedAt: timestamp }), true);
  assert.equal(isMonitorControlStartResponse({ startedAt: timestamp, extra: true }), false);

  const page = {
    frames: [{ source, sequence: 1, recordedAt: timestamp, payload }],
    nextSequence: 1,
    sealed: false,
  };
  assert.equal(isMonitorControlFramePage(page, 0, validPayload, source), true);
  assert.equal(isMonitorControlFramePage({ ...page, nextSequence: 2 }, 0, validPayload, source), false);
  assert.equal(isMonitorControlFramePage(page, 0, validPayload, '223e4567-e89b-42d3-a456-426614174000'), false);

  assert.equal(isMonitorControlSealRequest({ cutoffAt: timestamp }), true);
  assert.equal(isMonitorControlSealRequest({ cutoffAt: timestamp, force: true }), false);
  assert.equal(isMonitorControlSealResponse({ cutoffAt: timestamp, final: payload }, timestamp, validPayload), true);
  assert.equal(
    isMonitorControlSealResponse({ cutoffAt: '2026-09-28T08:42:04.123Z', final: payload }, timestamp, validPayload),
    false,
  );
});

test('keeps remote codes, statuses, messages, and client codes aligned', () => {
  for (const [code, definition] of Object.entries(monitorControlSchema.errors)) {
    const body = monitorControlErrorBody(code as keyof typeof monitorControlSchema.errors);
    assert.deepEqual(body, { code, message: definition.message });
    assert.equal(monitorControlClientError(definition.status, body), definition.clientCode);
    assert.equal(
      monitorControlClientError(definition.status, { ...body, message: 'Compatible older wording.' }),
      definition.clientCode,
    );
    assert.equal(monitorControlClientError(definition.status + 1, body), undefined);
    assert.equal(monitorControlClientError(definition.status, { ...body, message: '' }), undefined);
    assert.equal(
      monitorControlClientError(definition.status, {
        ...body,
        message: 'x'.repeat(monitorControlSchema.maximumErrorMessageCharacters),
      }),
      definition.clientCode,
    );
    assert.equal(
      monitorControlClientError(definition.status, {
        ...body,
        message: 'x'.repeat(monitorControlSchema.maximumErrorMessageCharacters + 1),
      }),
      undefined,
    );
    assert.equal(monitorControlClientError(definition.status, { ...body, message: 1 }), undefined);
    assert.equal(monitorControlClientError(definition.status, { ...body, extra: true }), undefined);
  }
});

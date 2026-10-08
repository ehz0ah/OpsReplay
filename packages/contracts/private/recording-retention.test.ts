import assert from 'node:assert/strict';
import test from 'node:test';
import openapi from '../openapi.json';
import publicSchema from '../schemas/public.schema.json';
import { recordingRetention, recordingRetainUntil } from './recording-retention.js';
import { recordingWorkTiming } from './recording-work.js';

const dayMs = 24 * 60 * 60 * 1000;

test('provisional recording retention exceeds the maximum active recording window', () => {
  const maximumSessionMs = publicSchema.$defs.SessionView.properties.timeLimitSeconds.maximum * 1000;
  assert.ok(recordingRetention.provisionalDays * dayMs > maximumSessionMs + recordingWorkTiming.postSessionWindowMs);
  assert.ok(recordingRetention.sealedDays > recordingRetention.provisionalDays);
});

test('recording retention boundaries are deterministic', () => {
  assert.equal(recordingRetainUntil('2026-10-07T00:00:01.000Z', 'provisional'), '2026-10-14T00:00:01.000Z');
  assert.equal(recordingRetainUntil('2026-10-07T00:00:03.000Z', 'sealed'), '2026-11-06T00:00:03.000Z');
  assert.throws(() => recordingRetainUntil('invalid', 'sealed'), /Invalid recording retention anchor/);
});

test('recording expiry is a playback error and does not expire the debrief', () => {
  assert.ok(openapi.paths['/v1/sessions/{id}/playback'].get.responses['410']);
  assert.equal('410' in openapi.paths['/v1/sessions/{id}/debrief'].get.responses, false);
  assert.ok(publicSchema.$defs.Error.properties.code.enum.includes('RECORDING_EXPIRED'));
});

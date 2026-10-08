import assert from 'node:assert/strict';
import test from 'node:test';
import publicSchema from '../schemas/public.schema.json';
import { recordingRetention } from './recording-retention.js';
import { recordingWorkTiming } from './recording-work.js';

const dayMs = 24 * 60 * 60 * 1000;

test('provisional recording retention exceeds the maximum active recording window', () => {
  const maximumSessionMs = publicSchema.$defs.SessionView.properties.timeLimitSeconds.maximum * 1000;
  assert.ok(recordingRetention.provisionalDays * dayMs > maximumSessionMs + recordingWorkTiming.postSessionWindowMs);
  assert.ok(recordingRetention.sealedDays > recordingRetention.provisionalDays);
});

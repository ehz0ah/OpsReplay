import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseRecordingWorkOrder,
  recordingWorkOrder,
  recordingWorkTiming,
  unfinishedWorkIndex,
} from './recording-work.js';

test('defines one stable sparse index contract for recording work', () => {
  assert.deepEqual(unfinishedWorkIndex, {
    name: 'unfinished-work',
    partitionKey: 'WorkPK',
    sortKey: 'WorkSK',
    recordingPartition: 'RECORDING',
  });
  assert.equal(recordingWorkTiming.postSessionWindowMs, 60_000);
  assert.equal(
    recordingWorkOrder('2026-10-08T01:02:03.004Z', '11111111-1111-4111-8111-111111111111'),
    '2026-10-08T01:02:03.004Z#SESSION#11111111-1111-4111-8111-111111111111',
  );
  assert.deepEqual(parseRecordingWorkOrder('2026-10-08T01:02:03.004Z#SESSION#11111111-1111-4111-8111-111111111111'), {
    sessionId: '11111111-1111-4111-8111-111111111111',
    workOrder: '2026-10-08T01:02:03.004Z#SESSION#11111111-1111-4111-8111-111111111111',
  });
  for (const [timestamp, sessionId] of [
    ['2026-10-08T01:02:03Z', '11111111-1111-4111-8111-111111111111'],
    ['not-a-time', '11111111-1111-4111-8111-111111111111'],
    ['2026-10-08T01:02:03.004Z', '11111111-1111-1111-8111-111111111111'],
    ['2026-10-08T01:02:03.004Z', 'not-a-session'],
  ]) {
    assert.throws(() => recordingWorkOrder(timestamp!, sessionId!), /Invalid recording work identity/);
  }
  for (const value of [null, '2026-10-08T01:02:03Z#SESSION#11111111-1111-4111-8111-111111111111', 'bad']) {
    assert.equal(parseRecordingWorkOrder(value), undefined);
  }
});

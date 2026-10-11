import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  deriveDebrief,
  type DebriefManifest,
  type DebriefMonitorEvent,
} from '../../../packages/session/src/debrief.js';
import type { CommandEvidence } from '../../../packages/contracts/private/command-evidence.js';
import { sessionRecord } from './session-fixture.js';
const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const manifest = json('../../../content/challenges/wrong-upstream-port/challenge.json') as DebriefManifest;
const expected = json('../../../packages/contracts/examples/debrief.json');
const timeline = json('../../../packages/contracts/examples/timeline.json').items;
const commands = timeline.filter((v: { kind: string }) => v.kind === 'command') as CommandEvidence[];
const events = timeline.filter((v: { kind: string }) => v.kind === 'monitor') as DebriefMonitorEvent[];
function session() {
  const value = sessionRecord(expected.sessionId);
  Object.assign(value.view, {
    status: 'resolved',
    readyAt: '2026-10-05T02:00:42Z',
    endedAt: '2026-10-05T02:07:03Z',
    recording: { status: 'complete', reason: null },
  });
  return value;
}
const counters = { totalRequests: 884, failedRequests: 640 };
test('production derivation matches the published evidence and raw score fixture', () => {
  assert.deepEqual(deriveDebrief(manifest, session(), commands, events, counters), expected);
});
test('evidence requires output from the same completed command, not an editor or a path mention', () => {
  const input = commands.map((v) => ({ ...v, outputExcerpt: '', changedFiles: [] }));
  const result = deriveDebrief(manifest, session(), input, events, counters);
  assert.ok(result.keyEvidence.every((v) => v.status === 'attempted'));
  assert.equal(result.possibleHarmfulActions.length, 1);
  const split = input.map((v) => (v.seq === 1 ? { ...v, outputExcerpt: commands[1]!.outputExcerpt } : v));
  assert.equal(deriveDebrief(manifest, session(), split, events, counters).keyEvidence[0]!.status, 'attempted');
});
test('cutoff excludes later commands and cannot credit an unfinished command', () => {
  const value = session();
  value.view.status = 'ended';
  value.view.endedAt = commands[2]!.at;
  const input = commands.map((v) => (v.seq === 2 ? { ...v, endedAt: '2026-10-05T02:10:00Z' } : v));
  const result = deriveDebrief(manifest, value, input, events, counters);
  assert.equal(result.keyEvidence[0]!.status, 'attempted');
  assert.equal(result.keyEvidence[2]!.status, 'not_observed');
  assert.equal(result.score!.commandCount, 3);
  assert.equal(result.score!.timeToRecoverySeconds, null);
  assert.deepEqual(result.possibleHarmfulActions, []);
});
test('incomplete recordings keep the outcome and explanations with a null score', () => {
  const value = session();
  value.view.recording = { status: 'incomplete', reason: 'data_gap' };
  value.view.assistance.assistantTurns = 1;
  const result = deriveDebrief(manifest, value, [], [], null);
  assert.equal(result.outcome, 'resolved');
  assert.equal(result.score, null);
  assert.equal(result.assisted, true);
  assert.ok(result.keyEvidence.every((v) => v.status === 'not_observed' && v.commandSeq === null));
});
test('duplicate commands, mismatched content, active sessions and missing complete counters fail closed', () => {
  assert.throws(() => deriveDebrief(manifest, session(), [...commands, commands[0]!], events, counters));
  assert.throws(() => deriveDebrief({ ...manifest, id: 'other' }, session(), commands, events, counters));
  const active = session();
  active.view.status = 'ready';
  assert.throws(() => deriveDebrief(manifest, active, commands, events, counters));
  assert.throws(() => deriveDebrief(manifest, session(), commands, events, null));
});

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
test('sequential investigation lists use their saved output without changing command count or impact', () => {
  const input = [
    {
      ...commands[0]!,
      command:
        'printf "marker: %s\\n" "${CHECKPOINT_RESUME:-absent}"; grep proxy_pass /etc/nginx/nginx.conf; curl http://127.0.0.1/',
      outputExcerpt: 'checking configuration\nproxy_pass http://127.0.0.1:8081;\n502',
    },
  ];
  const snapshot = structuredClone(input);
  const result = deriveDebrief(manifest, session(), input, events, counters);
  assert.equal(result.keyEvidence[2]!.status, 'observed');
  assert.equal(result.keyEvidence[2]!.commandSeq, input[0]!.seq);
  assert.equal(result.score!.commandCount, 1);
  assert.equal(result.score!.failedRequests, counters.failedRequests);
  assert.deepEqual(input, snapshot);
  for (const patch of [{ outputExcerpt: '' }, { endedAt: null, exitStatus: null }]) {
    assert.equal(
      deriveDebrief(manifest, session(), [{ ...input[0]!, ...patch }], events, counters).keyEvidence[2]!.status,
      'attempted',
    );
  }
});

test('quoted command mentions and unsupported shell branches receive no new evidence credit', () => {
  for (const command of [
    'printf "grep proxy_pass /etc/nginx/nginx.conf"',
    "printf 'a; grep proxy_pass /etc/nginx/nginx.conf'",
    'printf "checking"; false && grep proxy_pass /etc/nginx/nginx.conf',
    'printf "checking"; true || grep proxy_pass /etc/nginx/nginx.conf',
    'if false; then grep proxy_pass /etc/nginx/nginx.conf; fi',
    'printf "$(grep proxy_pass /etc/nginx/nginx.conf)"; true',
    'printf "checking"; (grep proxy_pass /etc/nginx/nginx.conf)',
    'printf "checking" # ; grep proxy_pass /etc/nginx/nginx.conf',
    'printf "checking";; grep proxy_pass /etc/nginx/nginx.conf',
    'exit; grep proxy_pass /etc/nginx/nginx.conf',
    'printf "checking"; return; grep proxy_pass /etc/nginx/nginx.conf',
    'printf "checking"; `grep proxy_pass /etc/nginx/nginx.conf`',
    'printf "checking"; grep proxy_pass /etc/nginx/nginx.conf "unfinished',
  ]) {
    const result = deriveDebrief(
      manifest,
      session(),
      [{ ...commands[0]!, command, outputExcerpt: 'proxy_pass http://127.0.0.1:8081;' }],
      events,
      counters,
    );
    assert.equal(result.keyEvidence[2]!.status, 'not_observed', command);
  }
});
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

test('learner-controlled proposal attribution cannot change numeric score components', () => {
  const unassisted = session();
  const baseline = deriveDebrief(manifest, unassisted, commands, events, counters);
  const attributed = session();
  attributed.view.assistance.proposalsRun = 500;
  const reflected = deriveDebrief(
    manifest,
    attributed,
    commands.map((command) => ({
      ...command,
      source: 'assistant',
      proposalId: '77777777-7777-4777-8777-777777777777',
    })),
    events,
    counters,
  );
  assert.deepEqual(reflected.score, baseline.score);
  assert.equal(reflected.assistance.proposalsRun, 500);
  assert.equal(reflected.assisted, true);
  assert.equal(baseline.assisted, false);
});

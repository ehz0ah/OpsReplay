import assert from 'node:assert/strict';
import { test } from 'node:test';
import { playbackHighlights, isPlaybackHighlights } from '../../../packages/session/src/playback-highlights.js';
import { playbackFixture, playbackAt } from './playback-fixture.js';
import { commandId, type CommandEvidence } from '../../../packages/contracts/private/command-evidence.js';
test('highlights include only observed evidence and measured recovery, without asserted causality', () => {
  const f = playbackFixture();
  const command: CommandEvidence = {
    id: commandId(f.source, 1),
    seq: 1,
    at: playbackAt,
    endedAt: playbackAt,
    kind: 'command',
    command: 'cat file',
    exitStatus: 0,
    source: 'learner',
    changedFiles: [],
    outputExcerpt: 'evidence',
    outputTruncated: false,
    metrics: null,
  };
  f.debrief.keyEvidence = [
    { id: 'observed', description: 'Visible evidence', status: 'observed', commandSeq: 1 },
    { id: 'attempted', description: 'Not enough output', status: 'attempted', commandSeq: 1 },
  ];
  f.debrief.possibleHarmfulActions = [
    { id: 'trap', description: 'Possible harm based on timing', commandSeq: 1, outageStartedAt: playbackAt },
  ];
  f.debrief.outages = [{ label: 'Proxy', startedAt: playbackAt, endedAt: null }];
  const values = playbackHighlights(f.debrief, {
    commands: [command],
    events: [
      { id: 'recovery', at: playbackAt, kind: 'monitor', signal: 'recovery_sustaining', label: 'Checks passing' },
    ],
    counters: null,
  });
  assert.ok(isPlaybackHighlights(values));
  assert.deepEqual(
    values.map((v) => v.kind),
    ['key_evidence', 'outage', 'possible_harmful_action', 'recovery'],
  );
  assert.equal(values.filter((v) => v.kind === 'key_evidence').length, 1);
  assert.ok(values.filter((v) => v.kind === 'outage' || v.kind === 'recovery').every((v) => v.commandSeq === null));
});

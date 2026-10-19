import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProposal, proposalCommand, isSavedProposal } from './assistant-proposal.js';
test('proposal filter preserves normal shell inspection and rejects control bytes and explicit environment exit', () => {
  assert.equal(proposalCommand('ss -ltn; cat /etc/nginx/nginx.conf'), true);
  for (const command of ['exit', 'kill -9 1', 'reboot', 'pwd\nrm -rf /', '\u001b[99~'])
    assert.equal(proposalCommand(command), false);
  const proposal = createProposal(
    { command: 'service nginx restart', rationale: 'Apply configuration' },
    '2026-10-20T01:00:00Z',
  );
  assert.equal(proposal?.caution, true);
  assert.equal(
    isSavedProposal({
      schemaVersion: 1,
      ownerId: 'owner',
      sessionId: 'a'.repeat(36),
      turnId: 'b'.repeat(36),
      view: proposal,
    }),
    false,
  );
});

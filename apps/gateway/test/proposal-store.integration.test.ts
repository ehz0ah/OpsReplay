import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, before, after } from 'node:test';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { startLocalDatabase } from '../../api/test/local-dynamodb.js';
import { sessionRecord } from '../../api/test/session-fixture.js';
import { AssistantStore } from '../../api/src/assistant/store.js';
import { DynamoProposalRunner } from '../src/proposal-store.js';
import type { BrowserTerminalSession } from '../src/browser-terminal-relay.js';
let db: Awaited<ReturnType<typeof startLocalDatabase>>;
before(async () => {
  db = await startLocalDatabase();
});
after(() => db.close());
async function fixture() {
  const table = 'proposal-' + randomUUID();
  await db.client.send(
    new CreateTableCommand({
      TableName: table,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
    }),
  );
  const state = sessionRecord(randomUUID()),
    at = Date.parse(state.view.createdAt);
  state.view.status = 'ready';
  state.view.readyAt = state.view.createdAt;
  state.view.endsAt = new Date(at + 1200000).toISOString();
  state.view.hints.nextAvailableAt = new Date(at + 180000).toISOString();
  const put = (SK: string, data: unknown) =>
    db.document.send(new PutCommand({ TableName: table, Item: { PK: 'SESSION#' + state.view.id, SK, data } }));
  await put('STATE', state);
  const store = new AssistantStore(db.document, table, () => at),
    turn = await store.admit(state.view.id, randomUUID(), 'help', state.ownerId, AbortSignal.timeout(5000));
  const result = await store.finish(
    state.view.id,
    turn.saved,
    'Inspect logs.',
    'completed',
    AbortSignal.timeout(5000),
    { command: 'cat /var/log/nginx/error.log', rationale: 'Read recent failures' },
  );
  assert.equal(result.proposals.length, 1);
  const input = {
    schemaVersion: 1,
    sessionId: state.view.id,
    connectionId: 'connection',
    generation: 1,
    claimedAt: state.view.createdAt,
  };
  await put('INPUT', input);
  let calls = 0;
  const receipts = new Set<string>();
  const session = {
    sessionId: state.view.id,
    connectionId: 'connection',
    generation: 1,
    proposal: async (frame: { token: string; query?: boolean }) => {
      // A duplicate confirmation may query the installed receipt. Queries
      // do not dispatch the command and cannot accept an unseen delivery.
      if (frame.query) return receipts.has(frame.token) ? ('accepted' as const) : ('unknown' as const);
      calls++;
      receipts.add(frame.token);
      return 'accepted' as const;
    },
  } as unknown as BrowserTerminalSession;
  return {
    state,
    put,
    store,
    session,
    runner: new DynamoProposalRunner(db.document, table, () => at),
    proposal: result.proposals[0]!,
    calls: () => calls,
  };
}
test('completed turn saves proposal atomically and duplicate confirmations deliver once', async () => {
  const f = await fixture();
  const outcomes = await Promise.all([
    f.runner.run(f.session, f.proposal.id, AbortSignal.timeout(10000)),
    f.runner.run(f.session, f.proposal.id, AbortSignal.timeout(10000)),
  ]);
  assert.ok(outcomes.includes('accepted'));
  assert.equal(f.calls(), 1);
  assert.equal(await f.runner.run(f.session, f.proposal.id, AbortSignal.timeout(10000)), 'accepted');
  assert.equal(f.calls(), 1);
  assert.equal(
    (await f.store.owned(f.state.view.id, f.state.ownerId, AbortSignal.timeout(10000))).view.assistance.proposalsRun,
    1,
  );
});
test('busy rejection permits explicit retry but uncertain delivery never resends', async () => {
  const f = await fixture();
  let calls = 0;
  const busy = {
    ...f.session,
    proposal: async () => {
      calls++;
      return 'busy' as const;
    },
  };
  await assert.rejects(f.runner.run(busy, f.proposal.id, AbortSignal.timeout(10000)), /TERMINAL_BUSY/);
  const lost = {
    ...f.session,
    proposal: async () => {
      calls++;
      throw new Error('lost acknowledgement');
    },
  };
  assert.equal(await f.runner.run(lost, f.proposal.id, AbortSignal.timeout(10000)), 'unknown');
  const queryOnly = {
    ...f.session,
    proposal: async (value: { query?: boolean }) => {
      assert.equal(value.query, true);
      return 'unknown' as const;
    },
  };
  assert.equal(await f.runner.run(queryOnly, f.proposal.id, AbortSignal.timeout(10000)), 'unknown');
  assert.equal(calls, 2);
  assert.equal(f.calls(), 0);
});
test('replaced input and expired sessions reject proposals before shell effects', async () => {
  const f = await fixture();
  await assert.rejects(
    f.runner.run({ ...f.session, generation: 2 }, f.proposal.id, AbortSignal.timeout(10000)),
    /PROPOSAL_UNAVAILABLE/,
  );
  assert.equal(
    await new DynamoProposalRunner(db.document, f.store.table, () => Date.parse(f.state.view.endsAt!) + 1).run(
      f.session,
      f.proposal.id,
      AbortSignal.timeout(10000),
    ),
    'expired',
  );
  assert.equal(f.calls(), 0);
});

test('status query never dispatches a still-pending proposal', async () => {
  const f = await fixture();
  assert.equal(await f.runner.run(f.session, f.proposal.id, AbortSignal.timeout(10000), true), 'pending');
  assert.equal(f.calls(), 0);
});

test('lost acknowledgement recovers acceptance by receipt query without dispatching again', async () => {
  const f = await fixture();
  let dispatched = 0,
    queries = 0;
  const connection = {
    ...f.session,
    proposal: async (frame: { query?: boolean }) => {
      if (frame.query) {
        queries++;
        return 'accepted' as const;
      }
      dispatched++;
      throw new Error('ack lost');
    },
  };
  assert.equal(await f.runner.run(connection, f.proposal.id, AbortSignal.timeout(10000)), 'unknown');
  assert.equal(await f.runner.run(connection, f.proposal.id, AbortSignal.timeout(10000), true), 'accepted');
  assert.equal(await f.runner.run(connection, f.proposal.id, AbortSignal.timeout(10000), true), 'accepted');
  assert.equal(dispatched, 1);
  assert.equal(queries, 1);
  assert.equal(
    (await f.store.owned(f.state.view.id, f.state.ownerId, AbortSignal.timeout(10000))).view.assistance.proposalsRun,
    1,
  );
});

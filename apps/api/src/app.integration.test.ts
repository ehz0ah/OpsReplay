import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command, SessionResponse } from '@opsreplay/contracts';
import { buildApp } from './app.js';
import { ContentRepository } from './content.js';
import { SqliteRepository } from './sqlite.js';
import { parse } from './validation.js';
import scenario from '../../../content/challenges/checkout-connection-leak/scenario.json' with { type: 'json' };

const secret = 'local-integration-test-secret-32-characters';
const rollback: Command = {
  tool: 'rollback_deployment',
  arguments: { service: 'checkout-api', targetVersion: '2.6.0' },
};
const metric: Command = {
  tool: 'get_metric',
  arguments: { service: 'database', metric: 'connections', windowTicks: 10 },
};
const scale: Command = {
  tool: 'scale_service',
  arguments: { service: 'checkout-api', instances: 6 },
};

describe('local API with transactional SQLite', () => {
  let directory: string, filename: string;
  let repository: SqliteRepository;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookies: Record<string, string>;

  const boot = async () => {
    repository = new SqliteRepository(filename);
    repository.setAccess('alice', true);
    repository.setAccess('bob', true);
    app = await buildApp({
      repository,
      content: new ContentRepository([scenario], true),
      secret,
      accounts: [
        { id: 'alice', name: 'Alice' },
        { id: 'bob', name: 'Bob' },
      ],
      origins: ['http://localhost:5173'],
    });
    await app.ready();
  };
  const headers = (owner = 'alice') => ({
    cookie: cookies[owner] ?? '',
    'x-opsreplay-client': 'web',
  });
  const create = async (requestId = randomUUID()) => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: headers(),
      payload: { requestId, contentId: scenario.id, contentVersion: scenario.version },
    });
    expect(response.statusCode).toBe(200);
    return parse('SessionResponse', response.json<unknown>());
  };
  const action = (
    session: SessionResponse['session'],
    command: Command,
    requestId = randomUUID(),
    owner = 'alice',
  ) =>
    app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/actions`,
      headers: headers(owner),
      payload: { requestId, expectedVersion: session.version, source: 'direct', command },
    });

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'opsreplay-api-'));
    filename = join(directory, 'sessions.sqlite');
    cookies = {};
    await boot();
    for (const owner of ['alice', 'bob']) {
      const response = await app.inject({
        method: 'POST',
        url: '/dev/login',
        headers: { 'x-opsreplay-client': 'web' },
        payload: { accountId: owner },
      });
      expect(response.statusCode).toBe(200);
      cookies[owner] = response.cookies
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join('; ');
    }
  });
  afterEach(async () => {
    await app.close();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('requires signed identity, access and an allowed origin', async () => {
    const missing = await app.inject({ url: '/v1/sessions' });
    expect(missing.statusCode).toBe(401);
    const forged = await app.inject({
      url: '/v1/sessions',
      headers: { cookie: 'opsreplay_local=alice' },
    });
    expect(forged.statusCode).toBe(401);
    const crossSite = await app.inject({
      method: 'POST',
      url: '/dev/login',
      headers: { 'x-opsreplay-client': 'web', origin: 'https://other.example' },
      payload: { accountId: 'alice' },
    });
    expect(crossSite.statusCode).toBe(403);
    repository.setAccess('alice', false);
    const denied = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: headers(),
      payload: {
        requestId: randomUUID(),
        contentId: scenario.id,
        contentVersion: scenario.version,
      },
    });
    expect(denied.statusCode).toBe(403);
    expect(parse('Error', denied.json<unknown>()).code).toBe('ACCESS_DENIED');
  });

  it('withholds private content and releases debrief only after ending', async () => {
    const created = await create();
    expect(JSON.stringify(created)).not.toContain(scenario.debrief.rootCause);
    expect(created.session.revealedEvidence.map((item) => item.kind)).toEqual(['alert']);
    const url = `/v1/sessions/${created.session.id}`;
    expect((await app.inject({ url: `${url}/debrief`, headers: headers() })).statusCode).toBe(422);
    const ended = await app.inject({
      method: 'POST',
      url: `${url}/end`,
      headers: headers(),
      payload: { requestId: randomUUID(), expectedVersion: 0 },
    });
    expect(parse('SessionResponse', ended.json<unknown>()).session.tick).toBe(0);
    const feedback = await app.inject({ url: `${url}/debrief`, headers: headers() });
    expect(parse('Debrief', feedback.json<unknown>()).rootCause).toBe(scenario.debrief.rootCause);
  });

  it('checks ownership before reads, writes, receipts and cursor decoding', async () => {
    const created = await create();
    const id = randomUUID();
    expect((await action(created.session, metric, id)).statusCode).toBe(200);
    for (const suffix of ['', '/events?cursor=bad', '/debrief', '/comparison']) {
      const response = await app.inject({
        url: `/v1/sessions/${created.session.id}${suffix}`,
        headers: headers('bob'),
      });
      expect(response.statusCode).toBe(404);
    }
    expect((await action(created.session, metric, id, 'bob')).statusCode).toBe(404);
  });

  it('returns a saved result with the current projection on retry', async () => {
    const initial = (await create()).session;
    const requestId = randomUUID();
    const first = parse(
      'ActionResponse',
      (await action(initial, metric, requestId)).json<unknown>(),
    );
    const next = parse('ActionResponse', (await action(first.session, rollback)).json<unknown>());
    const retried = parse(
      'ActionResponse',
      (await action(initial, metric, requestId)).json<unknown>(),
    );
    expect(retried.replayed).toBe(true);
    expect(retried.executedVersion).toBe(1);
    expect(retried.output).toEqual(first.output);
    expect(retried.events).toEqual(first.events);
    expect(retried.session).toEqual(next.session);
    const conflict = await action(initial, rollback, requestId);
    expect(parse('Error', conflict.json<unknown>()).code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('allows only one winner for different requests at the same version', async () => {
    const initial = (await create()).session;
    const responses = await Promise.all([action(initial, metric), action(initial, scale)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const saved = await repository.getOwnedSession('alice', initial.id);
    expect(saved.state.version).toBe(1);
    expect(await repository.history('alice', initial.id)).toHaveLength(1);
  });

  it('coalesces duplicate concurrent creates and actions', async () => {
    const requestId = randomUUID();
    const [first, duplicate] = await Promise.all([create(requestId), create(requestId)]);
    expect(first.session.id).toBe(duplicate.session.id);
    expect([first.replayed, duplicate.replayed].sort()).toEqual([false, true]);
    const id = randomUUID();
    const results = await Promise.all([
      action(first.session, metric, id),
      action(first.session, metric, id),
    ]);
    const values = results.map((response) => parse('ActionResponse', response.json<unknown>()));
    expect(values.map((value) => value.replayed).sort()).toEqual([false, true]);
    expect(values[0]?.output).toEqual(values[1]?.output);
  });

  it('recovers sessions, observations and receipts after closing the database', async () => {
    const createId = randomUUID();
    const initial = (await create(createId)).session;
    const actionId = randomUUID();
    const original = parse(
      'ActionResponse',
      (await action(initial, metric, actionId)).json<unknown>(),
    );
    await app.close();
    repository.close();
    await boot();
    const current = await app.inject({ url: `/v1/sessions/${initial.id}`, headers: headers() });
    expect(parse('SessionView', current.json<unknown>())).toEqual(original.session);
    expect((await create(createId)).session.id).toBe(initial.id);
    const duplicate = parse(
      'ActionResponse',
      (await action(initial, metric, actionId)).json<unknown>(),
    );
    expect(duplicate.replayed).toBe(true);
    expect(duplicate.output).toEqual(original.output);
  });

  it('rolls back all state when a receipt insert fails', async () => {
    const initial = (await create()).session;
    const db = new Database(filename);
    db.exec(
      "CREATE TRIGGER fail_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    try {
      const failed = await action(initial, metric);
      expect(failed.statusCode).toBe(500);
      expect(failed.body).not.toContain('injected failure');
      expect((await repository.getOwnedSession('alice', initial.id)).state.version).toBe(0);
      expect(await repository.history('alice', initial.id)).toEqual([]);
      expect(
        (await repository.listEvents('alice', initial.id, -1, 100)).map((event) => event.kind),
      ).toEqual(['session_started', 'observation']);
    } finally {
      db.close();
    }
  });

  it('paginates immutable events and binds cursors to owner, session and page size', async () => {
    const initial = (await create()).session;
    await action(initial, metric);
    const url = `/v1/sessions/${initial.id}/events`;
    const response = await app.inject({ url: `${url}?limit=2`, headers: headers() });
    expect(response.statusCode, response.body).toBe(200);
    const first = parse('EventPage', response.json<unknown>());
    expect(first.items.map((item) => item.sequence)).toEqual([1, 2]);
    expect(first.nextCursor).not.toBeNull();
    const token = encodeURIComponent(first.nextCursor ?? '');
    const second = parse(
      'EventPage',
      (
        await app.inject({ url: `${url}?limit=2&cursor=${token}`, headers: headers() })
      ).json<unknown>(),
    );
    expect(second.items.map((item) => item.sequence)).toEqual([3, 4]);
    expect(
      (await app.inject({ url: `${url}?limit=3&cursor=${token}`, headers: headers() })).statusCode,
    ).toBe(400);
    const other = (await create()).session;
    expect(
      (
        await app.inject({
          url: `/v1/sessions/${other.id}/events?limit=2&cursor=${token}`,
          headers: headers(),
        })
      ).statusCode,
    ).toBe(400);
  });

  it('preserves the original while comparing a different recovery path', async () => {
    const initial = (await create()).session;
    const scaled = parse('ActionResponse', (await action(initial, scale)).json<unknown>());
    const rolledBack = parse(
      'ActionResponse',
      (await action(scaled.session, rollback)).json<unknown>(),
    );
    const original = parse(
      'ActionResponse',
      (
        await action(rolledBack.session, { tool: 'advance_time', arguments: { ticks: 3 } })
      ).json<unknown>(),
    ).session;
    expect(original.status).toBe('resolved');
    const requestId = randomUUID();
    const payload = { requestId, expectedVersion: original.version, checkpointId: 'start' };
    const url = `/v1/sessions/${original.id}/replays`;
    const child = parse(
      'SessionResponse',
      (await app.inject({ method: 'POST', url, headers: headers(), payload })).json<unknown>(),
    );
    const duplicate = parse(
      'SessionResponse',
      (await app.inject({ method: 'POST', url, headers: headers(), payload })).json<unknown>(),
    );
    expect(duplicate.session.id).toBe(child.session.id);
    expect(duplicate.replayed).toBe(true);
    const fixed = parse(
      'ActionResponse',
      (await action(child.session, rollback)).json<unknown>(),
    ).session;
    const response = await app.inject({
      url: `/v1/sessions/${fixed.id}/comparison`,
      headers: headers(),
    });
    const comparison = parse('Comparison', response.json<unknown>());
    expect(comparison.original.impactUnits).toBe(200);
    expect(comparison.replay.impactUnits).toBe(0);
    expect(
      parse(
        'SessionView',
        (
          await app.inject({ url: `/v1/sessions/${original.id}`, headers: headers() })
        ).json<unknown>(),
      ),
    ).toEqual(original);
  });

  it('rejects untrusted commands and forged LLM proposals without mutation', async () => {
    const initial = (await create()).session;
    const url = `/v1/sessions/${initial.id}/actions`;
    for (const source of ['llm_tool', 'llm_confirmed']) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: headers(),
        payload: {
          requestId: randomUUID(),
          expectedVersion: 0,
          source,
          proposalId: randomUUID(),
          command: rollback,
        },
      });
      expect(response.statusCode).toBe(source === 'llm_tool' ? 400 : 422);
    }
    expect(
      (await action(initial, { tool: 'restart_service', arguments: { service: 'hidden' } }))
        .statusCode,
    ).toBe(422);
    expect((await repository.getOwnedSession('alice', initial.id)).state.version).toBe(0);
  });

  it('rejects production identity and changed pinned content', async () => {
    repository.pinContent(scenario.id, scenario.version, 'original');
    expect(() => repository.pinContent(scenario.id, scenario.version, 'changed')).toThrow(
      /changed/,
    );
    vi.stubEnv('NODE_ENV', 'production');
    await expect(
      buildApp({
        repository,
        content: new ContentRepository([scenario], true),
        secret,
        accounts: [],
        origins: [],
      }),
    ).rejects.toThrow(/disabled/);
  });

  it('enforces version checks across two independent database connections', async () => {
    const initial = (await create()).session;
    const secondStore = new SqliteRepository(filename);
    const secondApp = await buildApp({
      repository: secondStore,
      content: new ContentRepository([scenario], true),
      secret,
      accounts: [{ id: 'alice', name: 'Alice' }],
      origins: [],
    });
    try {
      const responses = await Promise.all([
        action(initial, metric),
        secondApp.inject({
          method: 'POST',
          url: `/v1/sessions/${initial.id}/actions`,
          headers: headers(),
          payload: {
            requestId: randomUUID(),
            expectedVersion: 0,
            source: 'direct',
            command: scale,
          },
        }),
      ]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      expect((await secondStore.getOwnedSession('alice', initial.id)).state.version).toBe(1);
    } finally {
      await secondApp.close();
      secondStore.close();
    }
  });

  it('rejects malformed requests and keeps owned session pagination stable', async () => {
    const first = (await create()).session;
    const second = (await create()).session;
    const response = await app.inject({ url: '/v1/sessions?limit=1', headers: headers() });
    const page = parse('SessionPage', response.json<unknown>());
    expect(page.items.map((item) => item.id)).toEqual([second.id]);
    const next = await app.inject({
      url: `/v1/sessions?limit=1&cursor=${encodeURIComponent(page.nextCursor ?? '')}`,
      headers: headers(),
    });
    expect(parse('SessionPage', next.json<unknown>()).items.map((item) => item.id)).toEqual([
      first.id,
    ]);
    expect(
      (await app.inject({ url: '/v1/sessions?limit=101', headers: headers() })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: '/v1/sessions?cursor=invalid', headers: headers() })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/sessions',
          headers: { ...headers(), 'content-type': 'application/json' },
          payload: '{',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('accepts catalogue pagination and validates filters', async () => {
    const response = await app.inject({ url: '/v1/catalog?mode=challenge&limit=1' });
    expect(response.statusCode).toBe(200);
    expect(parse('Catalog', response.json<unknown>()).items.map((item) => item.id)).toEqual([
      scenario.id,
    ]);
    expect((await app.inject({ url: '/v1/catalog?mode=unknown' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/v1/catalog?difficulty=' })).statusCode).toBe(400);
    const published = new ContentRepository([scenario], false);
    expect(published.catalog({}).items).toEqual([]);
  });
});

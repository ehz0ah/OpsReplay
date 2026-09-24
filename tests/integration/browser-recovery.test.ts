import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../apps/api/src/app.js';
import { ContentRepository } from '../../apps/api/src/content.js';
import { SqliteRepository } from '../../apps/api/src/sqlite.js';
import { RequestJournal } from '../../apps/web/src/api/journal.js';
import type { PendingRequest } from '../../apps/web/src/api/journal.js';
import { deliver, isDefinitiveRejection } from '../../apps/web/src/api/deliver.js';
import { read } from '../../apps/web/src/api/client.js';
import { createLearnerClient } from '../../apps/web/src/api/cache.js';
import { collectedObservations } from '../../apps/web/src/api/observations.js';
import type { EventPage, LogicalEvent, SessionView } from '@opsreplay/contracts';
import scenario from '../../content/challenges/checkout-connection-leak/scenario.json' with { type: 'json' };

// Real browser transport and request journal against the real API/storage.
// The fetch bridge drops or corrupts responses after Fastify has handled a write.
describe('browser request recovery through the local API', () => {
  let directory: string;
  let repository: SqliteRepository;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookie: string;
  let responseFault: 'drop' | 'unreadable' | 'invalid' | null;
  let journal: RequestJournal;
  const stored = new Map<string, string>();
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      stored.set(key, value);
    },
    removeItem: (key: string) => {
      stored.delete(key);
    },
  };
  const createRequest = (): PendingRequest => ({
    kind: 'start',
    label: 'Start challenge',
    body: { requestId: randomUUID(), contentId: scenario.id, contentVersion: scenario.version },
  });
  const login = async (id: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/dev/login',
      headers: { 'x-opsreplay-client': 'web' },
      payload: { accountId: id },
    });
    cookie = response.cookies.map((item) => item.name + '=' + item.value).join('; ');
  };
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'opsreplay-browser-'));
    repository = new SqliteRepository(join(directory, 'test.sqlite'));
    for (const id of ['alice', 'bob']) repository.setAccess(id, true);
    app = await buildApp({
      repository,
      content: new ContentRepository([scenario], true),
      secret: 'browser-integration-key-at-least-32-characters',
      accounts: [
        { id: 'alice', name: 'Alice' },
        { id: 'bob', name: 'Bob' },
      ],
      origins: ['http://127.0.0.1:5173'],
    });
    await app.ready();
    await login('alice');
    stored.clear();
    responseFault = null;
    journal = new RequestJournal(storage, 'alice');
    vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
      const response = await app.inject({
        method: init.method === 'POST' ? 'POST' : 'GET',
        url: path,
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          cookie,
          origin: 'http://127.0.0.1:5173',
        },
        ...(typeof init.body === 'string' ? { payload: init.body } : {}),
      });
      const fault = responseFault;
      responseFault = null;
      if (fault === 'drop') throw new TypeError('Connection lost after commit');
      return new Response(
        fault === 'unreadable'
          ? '<html>gateway error</html>'
          : fault === 'invalid'
            ? '{}'
            : response.body,
        { status: response.statusCode, headers: { 'Content-Type': 'application/json' } },
      );
    });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('recovers the original created attempt after a response is lost and the page reloads', async () => {
    const pending = createRequest();
    journal.save(pending);
    responseFault = 'drop';
    const error: unknown = await deliver('alice', pending).catch((error: unknown) => error);
    expect(isDefinitiveRejection(error)).toBe(false);
    const restored = new RequestJournal(storage, 'alice').load();
    expect(restored).toEqual(pending);
    if (!restored) throw new Error('Missing saved request');
    const recovered = await deliver('alice', restored);
    expect(recovered.replayed).toBe(true);
    expect(await repository.listSessions('alice', null, 100)).toHaveLength(1);
    journal.clear();
    expect(journal.load()).toBeNull();
  });

  it('does not apply a mitigation twice after losing its committed result', async () => {
    const initial = (await deliver('alice', createRequest())).session;
    const pending: PendingRequest = {
      kind: 'action',
      sessionId: initial.id,
      label: 'Scale checkout',
      body: {
        requestId: randomUUID(),
        expectedVersion: 0,
        source: 'direct',
        command: { tool: 'scale_service', arguments: { service: 'checkout-api', instances: 6 } },
      },
    };
    journal.save(pending);
    responseFault = 'drop';
    await expect(deliver('alice', pending)).rejects.toThrow(/Cannot reach/);
    const recovered = await deliver('alice', pending);
    expect(recovered.replayed).toBe(true);
    expect(recovered.session.tick).toBe(2);
    expect(recovered.session.version).toBe(1);
    expect(recovered.session.costs.impactUnits).toBe(140);
    expect(await repository.history('alice', initial.id)).toHaveLength(1);
  });

  it.each(['unreadable', 'invalid'] as const)(
    'retains a write after an %s response',
    async (fault) => {
      const pending = createRequest();
      journal.save(pending);
      responseFault = fault;
      const error: unknown = await deliver('alice', pending).catch((error: unknown) => error);
      expect(isDefinitiveRejection(error)).toBe(false);
      expect(journal.load()).toEqual(pending);
      expect((await deliver('alice', pending)).replayed).toBe(true);
    },
  );

  it('rejects a stale decision and loads the current version without repeating it', async () => {
    const initial = (await deliver('alice', createRequest())).session;
    const makeAction = (): PendingRequest => ({
      kind: 'action',
      label: 'Inspect',
      sessionId: initial.id,
      body: {
        requestId: randomUUID(),
        expectedVersion: 0,
        source: 'direct',
        command: {
          tool: 'get_metric',
          arguments: { service: 'database', metric: 'connections', windowTicks: 10 },
        },
      },
    });
    await deliver('alice', makeAction());
    const error: unknown = await deliver('alice', makeAction()).catch((error: unknown) => error);
    expect(isDefinitiveRejection(error)).toBe(true);
    expect(error).toMatchObject({ code: 'VERSION_CONFLICT' });
    const current = await read('SessionView', '/v1/sessions/' + initial.id, undefined, 'alice');
    expect(current.version).toBe(1);
    expect(current.tick).toBe(1);
  });

  it('cannot execute a saved create for another learner when a different tab changes the cookie', async () => {
    const pending = createRequest();
    journal.save(pending);
    await login('bob');
    await expect(deliver('alice', pending)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await repository.listSessions('bob', null, 100)).toHaveLength(0);
    expect(new RequestJournal(storage, 'bob').load()).toBeNull();
    await login('alice');
    expect((await deliver('alice', pending)).session.version).toBe(0);
  });

  it('rejects reads with a stale learner identity and keeps owned sessions unchanged', async () => {
    const initial = (await deliver('alice', createRequest())).session;
    await login('bob');
    await expect(
      read('SessionView', '/v1/sessions/' + initial.id, undefined, 'alice'),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect((await repository.getOwnedSession('alice', initial.id)).state.version).toBe(0);
  });

  it('keeps the latest displayed version when a read or write receipt arrives late', async () => {
    const initial = (await deliver('alice', createRequest())).session;
    const client = createLearnerClient();
    const queryKey = ['session', initial.id];
    client.setQueryData(queryKey, initial);
    let release!: (value: SessionView) => void;
    const delayed = new Promise<SessionView>((resolve) => {
      release = resolve;
    });
    const oldRead = await read('SessionView', '/v1/sessions/' + initial.id, undefined, 'alice');
    const inFlight = client.fetchQuery({ queryKey, queryFn: () => delayed, staleTime: 0 });
    const newer = (
      await deliver('alice', {
        kind: 'action',
        sessionId: initial.id,
        label: 'Scale checkout',
        body: {
          requestId: randomUUID(),
          expectedVersion: 0,
          source: 'direct',
          command: { tool: 'scale_service', arguments: { service: 'checkout-api', instances: 6 } },
        },
      })
    ).session;
    client.setQueryData(queryKey, newer);
    release(oldRead);
    await inFlight;
    expect(client.getQueryData(queryKey)).toEqual(newer);
    client.setQueryData(queryKey, initial);
    expect(client.getQueryData(queryKey)).toEqual(newer);
    client.clear();
  });

  it('recovers distinct old metric observations from paginated events without duplicates', async () => {
    let session = (await deliver('alice', createRequest())).session;
    const inspect = async () => {
      session = (
        await deliver('alice', {
          kind: 'action',
          sessionId: session.id,
          label: 'Inspect DB',
          body: {
            requestId: randomUUID(),
            expectedVersion: session.version,
            source: 'direct',
            command: {
              tool: 'get_metric',
              arguments: { service: 'database', metric: 'connections', windowTicks: 10 },
            },
          },
        })
      ).session;
    };
    await inspect();
    const first = session.revealedEvidence.find((item) => item.kind === 'metric');
    await inspect();
    const latest = session.revealedEvidence.filter((item) => item.kind === 'metric');
    expect(latest).toHaveLength(1);
    expect(latest[0]?.observationId).not.toBe(first?.observationId);
    const events: LogicalEvent[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: EventPage = await read(
        'EventPage',
        '/v1/sessions/' +
          session.id +
          '/events?limit=2' +
          (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
        undefined,
        'alice',
      );
      events.push(...page.items);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    const observations = collectedObservations(session, events).filter(
      (item) => item.kind === 'metric',
    );
    expect(observations).toEqual([first, latest[0]]);
    expect(observations[0]?.data).not.toEqual(observations[1]?.data);
  });
});

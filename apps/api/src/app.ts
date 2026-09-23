import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import type { Error as PublicError } from '@opsreplay/contracts';
import { EngineError } from '@opsreplay/engine';
import type { SessionRepository } from './repository.js';
import type { ContentRepository } from './content.js';
import { CursorCodec } from './cursor.js';
import { ApiError, statusFor } from './errors.js';
import { Sessions } from './sessions.js';
import { output, parse } from './validation.js';

export interface LocalAccount {
  id: string;
  name: string;
}
export interface AppOptions {
  repository: SessionRepository;
  content: ContentRepository;
  secret: string;
  accounts: LocalAccount[];
  origins: string[];
  logger?: boolean;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError('INVALID_REQUEST', 'Expected an object.');
  return value as Record<string, unknown>;
}

function query(request: FastifyRequest, allowed: string[]): Record<string, string> {
  const values = object(request.query);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (
      !allowed.includes(key) ||
      typeof value !== 'string' ||
      value.length < 1 ||
      value.length > 1000
    )
      throw new ApiError('INVALID_REQUEST', 'Invalid query parameters.');
    result[key] = value;
  }
  return result;
}

function page(request: FastifyRequest, extra: string[] = []) {
  const values = query(request, ['limit', 'cursor', ...extra]);
  const limit = values.limit === undefined ? 50 : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new ApiError('INVALID_REQUEST', 'Page size must be between 1 and 100.');
  return { limit, cursor: values.cursor };
}

function sessionId(request: FastifyRequest): string {
  const id = object(request.params).id;
  if (
    typeof id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
  )
    throw new ApiError('INVALID_REQUEST', 'Invalid session ID.');
  return id;
}

/** Explicit local runtime. Replace this identity adapter before deployment. */
export async function buildApp(options: AppOptions) {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Local identity is disabled in production.');
  const app = Fastify({
    logger: options.logger
      ? {
          redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'],
          serializers: {
            req: (request: FastifyRequest) => ({
              method: request.method,
              url: request.routeOptions.url ?? 'unmatched',
            }),
          },
        }
      : false,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    bodyLimit: 16 * 1024,
    requestTimeout: 15000,
    connectionTimeout: 15000,
  });
  const sessions = new Sessions(options.repository, options.content);
  const cursor = new CursorCodec(options.secret);
  await app.register(cookie, { secret: options.secret });

  function owner(request: FastifyRequest): string {
    const value = request.cookies.opsreplay_local;
    const signed = value ? request.unsignCookie(value) : null;
    if (
      !signed?.valid ||
      !signed.value ||
      !options.accounts.some((account) => account.id === signed.value) ||
      (request.headers['x-opsreplay-owner'] !== undefined &&
        request.headers['x-opsreplay-owner'] !== signed.value)
    )
      throw new ApiError('UNAUTHENTICATED', 'Select a local learner to continue.');
    return signed.value;
  }

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD'].includes(request.method)) {
      if (
        request.headers['x-opsreplay-client'] !== 'web' ||
        (request.headers.origin !== undefined && !options.origins.includes(request.headers.origin))
      )
        throw new ApiError('ACCESS_DENIED', 'Request origin is not allowed.');
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const known = error instanceof ApiError || error instanceof EngineError;
    const code: PublicError['code'] = known
      ? error.code
      : error instanceof Error &&
          'statusCode' in error &&
          typeof error.statusCode === 'number' &&
          error.statusCode < 500
        ? 'INVALID_REQUEST'
        : 'INTERNAL_ERROR';
    if (!known && code === 'INTERNAL_ERROR') request.log.error({ err: error }, 'Request failed');
    const body: PublicError = {
      code,
      message: known
        ? error.message
        : code === 'INVALID_REQUEST'
          ? 'Invalid request.'
          : 'The request could not be completed.',
      requestId: request.id,
    };
    if (error instanceof ApiError && error.currentVersion !== undefined)
      body.currentVersion = error.currentVersion;
    void reply.code(statusFor[code]).send(body);
  });
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ code: 'NOT_FOUND', message: 'Route not found.', requestId: request.id }),
  );

  app.get('/health', () => Promise.resolve({ status: 'ok' }));
  app.get('/dev/accounts', () => Promise.resolve({ accounts: options.accounts }));
  app.post('/dev/login', async (request, reply) => {
    const body = object(request.body);
    if (Object.keys(body).length !== 1 || typeof body.accountId !== 'string')
      throw new ApiError('INVALID_REQUEST', 'Select a local account.');
    const account = options.accounts.find((item) => item.id === body.accountId);
    if (!account) throw new ApiError('UNAUTHENTICATED', 'Unknown local account.');
    reply.setCookie('opsreplay_local', account.id, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      signed: true,
      maxAge: 60 * 60 * 24 * 30,
    });
    return { account };
  });
  app.post('/dev/logout', async (_request, reply) => {
    reply.clearCookie('opsreplay_local', { path: '/' });
    return { loggedOut: true };
  });
  app.get('/dev/me', (request) =>
    Promise.resolve({ account: options.accounts.find((item) => item.id === owner(request)) }),
  );

  app.get('/v1/catalog', (request) => {
    const names = ['mode', 'difficulty', 'domain', 'language'];
    const values = query(request, [...names, 'limit', 'cursor']);
    const filters = Object.fromEntries(
      names.flatMap((name) => (values[name] ? [[name, values[name]]] : [])),
    );
    if (
      (filters.mode && !['learn', 'challenge', 'code_review'].includes(filters.mode)) ||
      (filters.difficulty && !['easy', 'medium', 'hard'].includes(filters.difficulty)) ||
      Object.values(filters).some((value) => value.length > 80)
    )
      throw new ApiError('INVALID_REQUEST', 'Invalid catalogue filters.');
    const { limit, cursor: token } = page(request, names);
    const catalog = options.content.catalog(filters);
    const binding = JSON.stringify(['catalog', filters, limit]);
    const offset = cursor.decode(token, binding) ?? 0;
    return Promise.resolve(
      output('Catalog', {
        ...catalog,
        items: catalog.items.slice(offset, offset + limit),
        nextCursor:
          offset + limit < catalog.items.length ? cursor.encode(binding, offset + limit) : null,
      }),
    );
  });
  app.post('/v1/sessions', async (request) =>
    sessions.create(owner(request), parse('StartSessionRequest', request.body)),
  );
  app.get('/v1/sessions', async (request) => {
    const user = owner(request);
    const { limit, cursor: token } = page(request);
    const binding = JSON.stringify([user, 'sessions', limit]);
    const rows = await options.repository.listSessions(
      user,
      cursor.decode(token, binding),
      limit + 1,
    );
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return output('SessionPage', {
      items: items.map((row) => row.summary),
      nextCursor: rows.length > limit && last ? cursor.encode(binding, last.key) : null,
    });
  });
  app.get('/v1/sessions/:id', async (request) => sessions.get(owner(request), sessionId(request)));
  app.get('/v1/sessions/:id/events', async (request) => {
    const user = owner(request),
      id = sessionId(request);
    // Ownership precedes cursor checks and cannot be inferred from pagination errors.
    await options.repository.getOwnedSession(user, id);
    const { limit, cursor: token } = page(request);
    const binding = JSON.stringify([user, id, 'events', limit]);
    const rows = await options.repository.listEvents(
      user,
      id,
      cursor.decode(token, binding) ?? -1,
      limit + 1,
    );
    const items = rows.slice(0, limit),
      last = items.at(-1);
    return output('EventPage', {
      items,
      nextCursor: rows.length > limit && last ? cursor.encode(binding, last.sequence) : null,
    });
  });
  app.post('/v1/sessions/:id/actions', async (request) =>
    sessions.action(owner(request), sessionId(request), parse('ActionRequest', request.body)),
  );
  app.post('/v1/sessions/:id/end', async (request) =>
    sessions.end(owner(request), sessionId(request), parse('VersionedRequest', request.body)),
  );
  app.get('/v1/sessions/:id/debrief', async (request) =>
    sessions.debrief(owner(request), sessionId(request)),
  );
  app.post('/v1/sessions/:id/replays', async (request) =>
    sessions.replay(owner(request), sessionId(request), parse('ReplayRequest', request.body)),
  );
  app.get('/v1/sessions/:id/comparison', async (request) =>
    sessions.compare(owner(request), sessionId(request)),
  );
  return app;
}

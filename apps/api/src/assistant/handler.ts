import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import schema from '../../../../packages/contracts/schemas/public.schema.json';
import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import { validOwner, validUuid } from '../start-session/validation.js';
import { ActionError } from '../shared/action.js';
import { AssistantStore, AssistantError } from './store.js';
import { buildAssistantContext } from './context.js';
import type { AssistantProvider } from './provider.js';
const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addSchema(schema);
const validRequest = ajv.getSchema(schema.$id + '#/$defs/MessageRequest')!;
export interface AssistantResponse {
  statusCode: number;
  body: unknown;
}
export function createAssistantHandler(
  store: AssistantStore,
  provider: AssistantProvider | null,
  report: (value: object) => void = () => {},
) {
  return async (
    event: APIGatewayProxyEvent,
    context: Pick<Context, 'getRemainingTimeInMillis'>,
    emit: (event: PublicTypes['StreamEvent']) => void,
  ): Promise<AssistantResponse> => {
    let requestId: string = randomUUID(),
      sequence = 0,
      opened = false;
    const failure = (code: string, statusCode: number) => ({
      statusCode,
      body: {
        code,
        message:
          code === 'TURN_IN_PROGRESS'
            ? 'An assistant turn is already running.'
            : code === 'ASSISTANT_UNAVAILABLE'
              ? 'The assistant is unavailable. Continue with the terminal and hints.'
              : 'The assistant request could not finish. Read the saved turn before retrying.',
        requestId,
      },
    });
    try {
      const owner: unknown = event.requestContext?.authorizer?.claims?.sub;
      if (!validOwner(owner)) return failure('UNAUTHENTICATED', 401);
      const id = event.pathParameters?.id;
      if (
        event.httpMethod !== 'POST' ||
        event.resource !== '/v1/sessions/{id}/messages' ||
        !validUuid(id) ||
        event.isBase64Encoded ||
        !event.body ||
        Buffer.byteLength(event.body) > 16000 ||
        Object.keys(event.multiValueQueryStringParameters ?? event.queryStringParameters ?? {}).length
      )
        return failure('INVALID_REQUEST', 400);
      let input: unknown;
      try {
        input = JSON.parse(event.body);
      } catch {
        return failure('INVALID_REQUEST', 400);
      }
      if (!validRequest(input)) return failure('INVALID_REQUEST', 400);
      const request = input as PublicTypes['MessageRequest'];
      requestId = request.requestId;
      const available = context.getRemainingTimeInMillis() - 3000;
      if (available < 5000) throw new Error('Insufficient turn budget.');
      const signal = AbortSignal.timeout(available);
      const admitted = await store.admit(id, requestId, request.text, owner, signal, provider !== null);
      const send = (type: PublicTypes['StreamEvent']['type'], data: unknown) => {
        const value = { type, turnId: requestId, sequence: sequence++, data } as PublicTypes['StreamEvent'];
        try {
          emit(value);
        } catch {
          /* A disconnected learner can still read the saved bounded result. */
        }
      };
      opened = true;
      send('turn_started', { requestId });
      if (!admitted.fresh) {
        if (admitted.saved.view.status === 'completed') send('turn_completed', admitted.saved.view);
        else if (admitted.saved.view.status !== 'running')
          send('turn_failed', {
            code: admitted.saved.view.status === 'interrupted' ? 'TURN_INTERRUPTED' : 'ASSISTANT_UNAVAILABLE',
            message: 'This turn did not complete.',
            requestId,
          });
        return { statusCode: 200, body: null };
      }
      const started = performance.now();
      try {
        const timeout = Math.min(45000, Date.parse(admitted.saved.view.expiresAt) - store.now() - 3000);
        if (timeout <= 0) throw new AssistantError('TURN_INTERRUPTED');
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
        if (!provider) throw new AssistantError('ASSISTANT_UNAVAILABLE');
        const live = await store.get(id, 'LIVE_MONITOR', bounded);
        const evidence = await buildAssistantContext(store.client, store.table, admitted.session, live, bounded);
        const history = await store.history(id, owner, requestId, bounded);
        const reply = await withSignal(
          provider.reply(
            evidence,
            history,
            request.text,
            (text) => {
              if (!bounded.aborted) send('text_delta', { text });
            },
            bounded,
          ),
          bounded,
        );
        const saved = await store.finish(id, admitted.saved, reply.text, 'completed', signal);
        send('turn_completed', saved);
        try {
          report({
            operation: 'assistant_turn',
            turnId: requestId,
            status: 'completed',
            durationMs: Math.round(performance.now() - started),
            ...reply.usage,
          });
        } catch {
          /* No evidence text is logged. */
        }
      } catch (error) {
        let code = 'ASSISTANT_UNAVAILABLE';
        try {
          await store.finish(id, admitted.saved, '', 'failed', signal);
        } catch {
          code = 'TURN_INTERRUPTED';
        }
        send('turn_failed', {
          code,
          message: 'The assistant did not finish. Terminal and hints remain available.',
          requestId,
        });
        try {
          report({
            operation: 'assistant_turn',
            turnId: requestId,
            status: 'failed',
            durationMs: Math.round(performance.now() - started),
            reason: error instanceof AssistantError ? error.code : 'provider_or_context_failure',
          });
        } catch {}
      }
      return { statusCode: 200, body: null };
    } catch (error) {
      const code = error instanceof ActionError || error instanceof AssistantError ? error.code : 'INTERNAL_ERROR';
      if (opened) return { statusCode: 200, body: null };
      return failure(
        code,
        code === 'NOT_FOUND'
          ? 404
          : code === 'UNAUTHENTICATED'
            ? 401
            : code === 'INVALID_REQUEST'
              ? 400
              : code === 'ASSISTANT_UNAVAILABLE'
                ? 503
                : code === 'LIMIT_EXCEEDED'
                  ? 429
                  : code === 'INTERNAL_ERROR'
                    ? 500
                    : 409,
      );
    }
  };
}

/** Enforce the caller's deadline even if an adapter fails to honour cancellation. */
export async function withSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers/promises';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import type { StartStore } from './store.js';
import type { LaunchConfiguration, Receipt, SessionRecord, SessionView, StartRequest } from './types.js';
import { isStartableContent, validOwner, validRequest, validSession, validSessionRelations, validUuid, validView } from './validation.js';

const RESPONSE_MARGIN_MS = 1000;

const errors = {
  INVALID_REQUEST: [400, 'Invalid session start request.'],
  UNAUTHENTICATED: [401, 'Sign in before starting a Challenge.'],
  ACCESS_DENIED: [403, 'Your plan does not include this Challenge.'],
  NOT_FOUND: [404, 'Session not found.'],
  IDEMPOTENCY_CONFLICT: [409, 'This request ID was already used for a different request.'],
  ACTIVE_SESSION_EXISTS: [409, 'Finish or end your current Challenge before starting another.'],
  VERSION_UNAVAILABLE: [422, 'This Challenge version is not available.'],
  LIMIT_EXCEEDED: [429, 'The attempt limit for this Challenge has been reached.'],
  CAPACITY_UNAVAILABLE: [503, 'No environment capacity is available. Try again shortly.'],
  INTERNAL_ERROR: [500, 'The request could not be completed. Retry with the same request ID.'],
} as const;
class RequestError extends Error {
  constructor(readonly code: keyof typeof errors, readonly activeSessionId?: string) { super(code); }
}
function retryableConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TransactionConflictException') return true;
  if (error.name !== 'TransactionCanceledException' || !('CancellationReasons' in error)) return false;
  const reasons = error.CancellationReasons;
  return Array.isArray(reasons)
    && reasons.some(reason => ['ConditionalCheckFailed', 'TransactionConflict'].includes(reason?.Code))
    && reasons.every(reason => ['None', 'ConditionalCheckFailed', 'TransactionConflict'].includes(reason?.Code));
}
export interface StartLog {
  operation: 'start_session';
  requestId: string;
  result: string;
  durationMs: number;
}
interface Dependencies {
  store: Pick<StartStore, 'receipt' | 'session' | 'active' | 'snapshot' | 'commit'>;
  launchConfiguration: LaunchConfiguration;
  provision: (sessionId: string, abortSignal?: AbortSignal) => Promise<'launched' | 'already_launched' | 'expired' | 'terminal' | 'capacity_unavailable'>;
  now?: () => Date;
  newId?: () => string;
  newSecret?: () => string;
  log?: (entry: StartLog) => void;
}
const response = (statusCode: number, body: object): APIGatewayProxyResult => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

// Every nested object is projected explicitly. Never spread a private record into a response.
export function publicView(view: SessionView): SessionView {
  const { id, challenge, attempt, status, statusReason, alert, dashboard, recovery,
    timeLimitSeconds, createdAt, readyAt, endsAt, endedAt, hints, assistance,
    debriefAvailable, recording } = view;
  const result = {
    id, challenge: { id: challenge.id, version: challenge.version, title: challenge.title, tier: challenge.tier, category: challenge.category },
    attempt: { kind: attempt.kind, number: attempt.number }, status, statusReason,
    alert: { title: alert.title, summary: alert.summary, severity: alert.severity },
    dashboard: dashboard.map(({ id, label, unit }) => ({ id, label, unit })),
    recovery: recovery === null ? null : { state: recovery.state, sustainedSeconds: recovery.sustainedSeconds, requiredSeconds: recovery.requiredSeconds },
    timeLimitSeconds, createdAt, readyAt, endsAt, endedAt,
    hints: { released: hints.released.map(({ id, text, releasedAt }) => ({ id, text, releasedAt })), remaining: hints.remaining, nextAvailableAt: hints.nextAvailableAt },
    assistance: { hintsReleased: assistance.hintsReleased, assistantTurns: assistance.assistantTurns, proposalsRun: assistance.proposalsRun },
    debriefAvailable, recording: { status: recording.status, reason: recording.reason },
  };
  if (!validView(result)) throw new Error('Invalid session projection');
  return result;
}

function parseBody(event: APIGatewayProxyEvent): StartRequest {
  if (typeof event.body !== 'string' || event.body.length > 12_000) throw new RequestError('INVALID_REQUEST');
  let value: unknown;
  try {
    if (event.isBase64Encoded && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.body)) {
      throw new Error('Invalid base64');
    }
    const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    if (Buffer.byteLength(body) > 8192) throw new Error('Request too large');
    value = JSON.parse(body);
  } catch { throw new RequestError('INVALID_REQUEST'); }
  if (!validRequest(value)) throw new RequestError('INVALID_REQUEST');
  return { ...value, requestId: value.requestId.toLowerCase() };
}

export function createStartHandler({ store, launchConfiguration, provision, now = () => new Date(), newId = randomUUID,
  newSecret = () => randomBytes(32).toString('base64url'), log = () => {} }: Dependencies) {
  return async (event: APIGatewayProxyEvent,
    context: Pick<Context, 'awsRequestId' | 'getRemainingTimeInMillis'>): Promise<APIGatewayProxyResult> => {
    const started = performance.now();
    let requestId = validUuid(context.awsRequestId) ? context.awsRequestId : randomUUID();
    let result = 'INTERNAL_ERROR';
    try {
      // API Gateway must attach a Cognito authorizer. Headers and body identity are never trusted.
      const owner: unknown = event.requestContext?.authorizer?.claims?.sub;
      if (!validOwner(owner)) throw new RequestError('UNAUTHENTICATED');
      if (event.httpMethod !== 'POST' || event.resource !== '/v1/sessions') throw new RequestError('INVALID_REQUEST');
      const request = parseBody(event);
      requestId = request.requestId;
      const hash = createHash('sha256').update(JSON.stringify({
        challengeId: request.challengeId, challengeVersion: request.challengeVersion,
      })).digest('hex');
      const workTimeMs = context.getRemainingTimeInMillis() - RESPONSE_MARGIN_MS;
      const abortSignal = workTimeMs > 0 ? AbortSignal.timeout(workTimeMs) : AbortSignal.abort();

      const replay = async () => {
        abortSignal.throwIfAborted();
        const receipt: Receipt | undefined = await store.receipt(owner, requestId, abortSignal);
        if (!receipt) return undefined;
        if (receipt.ownerId !== owner || receipt.requestId !== requestId) throw new RequestError('NOT_FOUND');
        if (receipt.hash !== hash) throw new RequestError('IDEMPOTENCY_CONFLICT');
        abortSignal.throwIfAborted();
        const saved = await store.session(receipt.sessionId, abortSignal);
        if (!saved || saved.ownerId !== owner || saved.view.id !== receipt.sessionId) throw new RequestError('NOT_FOUND');
        const provisioned = await provision(saved.view.id, abortSignal);
        if (provisioned === 'capacity_unavailable') throw new RequestError('CAPACITY_UNAVAILABLE');
        const current = await store.session(receipt.sessionId, abortSignal);
        if (!current || current.ownerId !== owner || current.view.id !== receipt.sessionId) throw new RequestError('NOT_FOUND');
        result = 'replayed';
        return response(200, { session: publicView(current.view), replayed: true });
      };
      const rejectNew = async (code: keyof typeof errors, activeSessionId?: string) => {
        // Another invocation may have committed after our receipt miss, even if access changed.
        const raced = await replay();
        if (raced) return raced;
        throw new RequestError(code, activeSessionId);
      };

      // Retry only known transaction contention. Unknown write outcomes return a retryable error.
      for (let attempt = 0; attempt < 3; attempt++) {
        const existing = await replay();
        if (existing) return existing;
        abortSignal.throwIfAborted();
        const [snapshot, active] = await Promise.all([
          store.snapshot(owner, request, abortSignal),
          store.active(owner, abortSignal),
        ]);
        const content = snapshot.content;
        if (!isStartableContent(content) || content.challenge.id !== request.challengeId
          || content.challenge.version !== request.challengeVersion) return await rejectNew('VERSION_UNAVAILABLE');
        const clock = now();
        const plan = snapshot.plan?.plan === 'pro'
          && (snapshot.plan.expiresAt === null || Date.parse(snapshot.plan.expiresAt) > clock.getTime()) ? 'pro' : 'free';
        if (content.plan === 'pro' && plan !== 'pro') return await rejectNew('ACCESS_DENIED');
        const timeLimitSeconds = content.timeLimits[plan];
        const completed = snapshot.progress?.completedAttempts ?? 0;
        if (completed >= 1000) return await rejectNew('LIMIT_EXCEEDED');
        if (active) {
          return await rejectNew('ACTIVE_SESSION_EXISTS', active.sessionId);
        }
        const createdAt = clock.toISOString();
        const id = newId();
        const monitorSecret = newSecret();
        const provisioningDeadline = new Date(clock.getTime() + 180_000);
        const view: SessionView = publicView({
          id, challenge: content.challenge, alert: content.alert, dashboard: content.dashboard,
          attempt: { kind: completed === 0 ? 'first' : 'retry', number: completed + 1 },
          status: 'provisioning', statusReason: null, recovery: null, timeLimitSeconds, createdAt,
          readyAt: null, endsAt: null, endedAt: null,
          hints: { released: [], remaining: content.hintCount, nextAvailableAt: null },
          assistance: { hintsReleased: 0, assistantTurns: 0, proposalsRun: 0 },
          debriefAvailable: false, recording: { status: 'pending', reason: null },
        });
        const session: SessionRecord = {
          ownerId: owner, view, accessGrant: { plan, admittedAt: createdAt, timeLimitSeconds },
          pins: { ...content.pins },
          launchArguments: {
            cluster: launchConfiguration.clusterArn,
            taskDefinition: content.pins.taskDefinitionArn,
            clientToken: id,
            startedBy: id,
            count: 1,
            enableExecuteCommand: false,
            launchType: 'FARGATE',
            platformVersion: launchConfiguration.platformVersion,
            networkConfiguration: { awsvpcConfiguration: {
              subnets: [...launchConfiguration.subnetIds],
              securityGroups: [...launchConfiguration.securityGroupIds],
              assignPublicIp: 'DISABLED',
            } },
            overrides: { containerOverrides: [{
              name: launchConfiguration.monitorContainerName,
              environment: [
                { name: 'OPSREPLAY_SESSION_ID', value: id },
                { name: 'OPSREPLAY_MONITOR_SECRET', value: monitorSecret },
              ],
            }] },
            tags: [{ key: 'opsreplay:session-id', value: id }],
          },
          monitorSecret,
          provisioningDeadline: provisioningDeadline.toISOString(),
          launchRecoveryDeadline: new Date(provisioningDeadline.getTime() + 300_000).toISOString(),
          scheduleName: `session-${id}`,
          taskArn: null,
          provisioningCleanup: { status: 'pending', completedAt: null },
        };
        if (!validSession(session) || !validSessionRelations(session)) throw new Error('Invalid session launch configuration');
        try {
          abortSignal.throwIfAborted();
          await store.commit({ request, session, snapshot, receipt: { ownerId: owner, requestId, hash, sessionId: id } }, abortSignal);
        } catch (error) {
          const committed = await replay();
          if (committed) return committed;
          if (!retryableConflict(error)) throw error;
          if (attempt < 2) await setTimeout(20 * 2 ** attempt, undefined, { signal: abortSignal });
          continue;
        }
        const provisioned = await provision(id, abortSignal);
        if (provisioned === 'capacity_unavailable') throw new RequestError('CAPACITY_UNAVAILABLE');
        result = 'created';
        const current = await store.session(id, abortSignal);
        if (!current) throw new Error('Session disappeared after admission');
        return response(200, { session: publicView(current.view), replayed: false });
      }
      throw new Error('Admission contention limit reached');
    } catch (error) {
      const failure = error instanceof RequestError ? error : new RequestError('INTERNAL_ERROR');
      result = failure.code;
      const [statusCode, message] = errors[failure.code];
      return response(statusCode, {
        code: failure.code, message, requestId,
        ...(failure.activeSessionId ? { activeSessionId: failure.activeSessionId } : {}),
        ...(failure.code === 'CAPACITY_UNAVAILABLE' ? { retryAfterSeconds: 30 } : {}),
      });
    } finally {
      // No events, user identifiers, tokens, database errors, or private content in logs.
      try { log({ operation: 'start_session', requestId, result, durationMs: Math.round(performance.now() - started) }); } catch { /* Logging must not change a committed result. */ }
    }
  };
}

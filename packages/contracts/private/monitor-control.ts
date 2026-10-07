export const monitorControlSchema = Object.freeze({
  routes: {
    health: { method: 'GET', path: '/healthz', readyStatus: 200, unavailableStatus: 503 },
    start: { method: 'POST', path: '/v1/start', successStatus: 200 },
    frames: { method: 'GET', path: '/v1/frames', successStatus: 200, cursorParameter: 'after' },
    seal: { method: 'POST', path: '/v1/seal', successStatus: 200 },
  },
  healthStates: ['starting', 'ready', 'failed'],
  maximumCursor: 999_999,
  maximumFramesPerPage: 100,
  maximumRequestBytes: 1_024,
  maximumResponseBytes: 65_536,
  errors: {
    AUTH_FAILED: { status: 401, message: 'Monitor authentication failed.', clientCode: 'auth_failed' },
    INVALID_REQUEST: { status: 400, message: 'Invalid monitor request.', clientCode: 'invalid_request' },
    INVALID_STATE: {
      status: 409,
      message: 'Monitor state does not permit this operation.',
      clientCode: 'invalid_state',
    },
    RATE_LIMITED: { status: 429, message: 'Monitor request rate exceeded.', clientCode: 'rate_limited' },
    UNAVAILABLE: { status: 503, message: 'Monitor is not available.', clientCode: 'unavailable' },
    INTERNAL_ERROR: { status: 500, message: 'Monitor operation failed.', clientCode: 'unavailable' },
  },
} as const);

type Schema = typeof monitorControlSchema;

export type MonitorControlHealth = Schema['healthStates'][number];
export type MonitorControlErrorCode = keyof Schema['errors'];
export type MonitorControlClientErrorCode = Schema['errors'][MonitorControlErrorCode]['clientCode'];

export interface MonitorControlHealthResponse {
  status: MonitorControlHealth;
}

export interface MonitorControlStartResponse {
  startedAt: string;
}

export interface MonitorControlFrame<TPayload> {
  source: string;
  sequence: number;
  recordedAt: string;
  payload: TPayload;
}

export interface MonitorControlFramePage<TPayload> {
  frames: MonitorControlFrame<TPayload>[];
  nextSequence: number;
  sealed: boolean;
}

export interface MonitorControlSealRequest {
  cutoffAt: string;
}

export interface MonitorControlSealResponse<TMetric> {
  cutoffAt: string;
  final: TMetric;
}

export type MonitorControlErrorBody = {
  [Code in MonitorControlErrorCode]: {
    code: Code;
    message: Schema['errors'][Code]['message'];
  };
}[MonitorControlErrorCode];

export type MonitorControlResponse<TPayload, TMetric> =
  | MonitorControlHealthResponse
  | MonitorControlStartResponse
  | MonitorControlFramePage<TPayload>
  | MonitorControlSealResponse<TMetric>
  | MonitorControlErrorBody;

type Validator<T> = (value: unknown) => value is T;

const canonicalTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const source = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function isMonitorControlTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !canonicalTimestamp.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function parseMonitorControlCursor(value: string): number | undefined {
  if (!/^(0|[1-9][0-9]{0,5})$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed <= monitorControlSchema.maximumCursor ? parsed : undefined;
}

export function isMonitorControlSource(value: unknown): value is string {
  return typeof value === 'string' && source.test(value);
}

export function isMonitorControlHealthResponse(value: unknown): value is MonitorControlHealthResponse {
  return (
    record(value) &&
    exact(value, ['status']) &&
    typeof value.status === 'string' &&
    (monitorControlSchema.healthStates as readonly string[]).includes(value.status)
  );
}

export function isMonitorControlStartResponse(value: unknown): value is MonitorControlStartResponse {
  return record(value) && exact(value, ['startedAt']) && isMonitorControlTimestamp(value.startedAt);
}

export function isMonitorControlFrame<TPayload>(
  value: unknown,
  validPayload: Validator<TPayload>,
): value is MonitorControlFrame<TPayload> {
  return (
    record(value) &&
    exact(value, ['source', 'sequence', 'recordedAt', 'payload']) &&
    isMonitorControlSource(value.source) &&
    Number.isInteger(value.sequence) &&
    (value.sequence as number) >= 1 &&
    (value.sequence as number) <= monitorControlSchema.maximumCursor &&
    isMonitorControlTimestamp(value.recordedAt) &&
    validPayload(value.payload)
  );
}

export function isMonitorControlFramePage<TPayload>(
  value: unknown,
  after: number,
  validPayload: Validator<TPayload>,
  expectedSource?: string,
): value is MonitorControlFramePage<TPayload> {
  if (
    !record(value) ||
    !exact(value, ['frames', 'nextSequence', 'sealed']) ||
    !Array.isArray(value.frames) ||
    value.frames.length > monitorControlSchema.maximumFramesPerPage ||
    !Number.isInteger(value.nextSequence) ||
    (value.nextSequence as number) < after ||
    (value.nextSequence as number) > monitorControlSchema.maximumCursor ||
    typeof value.sealed !== 'boolean'
  ) {
    return false;
  }
  let sequence = after;
  let frameSource = expectedSource;
  for (const candidate of value.frames) {
    if (
      !isMonitorControlFrame(candidate, validPayload) ||
      candidate.sequence !== sequence + 1 ||
      (frameSource !== undefined && candidate.source !== frameSource)
    ) {
      return false;
    }
    frameSource ??= candidate.source;
    sequence = candidate.sequence;
  }
  return value.nextSequence === sequence;
}

export function isMonitorControlSealRequest(value: unknown): value is MonitorControlSealRequest {
  return record(value) && exact(value, ['cutoffAt']) && isMonitorControlTimestamp(value.cutoffAt);
}

export function isMonitorControlSealResponse<TMetric>(
  value: unknown,
  cutoffAt: string,
  validMetric: Validator<TMetric>,
): value is MonitorControlSealResponse<TMetric> {
  return (
    record(value) && exact(value, ['cutoffAt', 'final']) && value.cutoffAt === cutoffAt && validMetric(value.final)
  );
}

export function monitorControlErrorBody<Code extends MonitorControlErrorCode>(
  code: Code,
): Extract<MonitorControlErrorBody, { code: Code }> {
  const definition = monitorControlSchema.errors[code];
  return { code, message: definition.message } as Extract<MonitorControlErrorBody, { code: Code }>;
}

export function monitorControlClientError(status: number, value: unknown): MonitorControlClientErrorCode | undefined {
  if (!record(value) || !exact(value, ['code', 'message']) || typeof value.code !== 'string') return undefined;
  const code = value.code as MonitorControlErrorCode;
  if (!Object.hasOwn(monitorControlSchema.errors, code)) return undefined;
  const definition = monitorControlSchema.errors[code];
  if (definition.status !== status || value.message !== definition.message) return undefined;
  return definition.clientCode;
}

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import publicSchema from '../schemas/public.schema.json';
import { isMonitorControlSource, isMonitorControlTimestamp, monitorControlSchema } from './monitor-control.js';
import { monitorRecordingLimits } from './monitor-persistence.js';
import { isTerminalSessionId } from './terminal-access.js';

export interface LiveMetricMessage {
  type: 'metrics';
  sample: { at: string; values: Record<string, number> };
  counters: { totalRequests: number; failedRequests: number };
  recovery: { state: 'failing' | 'sustaining' | 'met'; sustainedSeconds: number; requiredSeconds: number };
}

/** Latest public metric committed with an accepted Monitor page. The frontier proves
 * that the replaceable sample belongs to durable recording state. */
export interface MonitorLiveTelemetry {
  schemaVersion: 1;
  sessionId: string;
  startedAt: string;
  source: string;
  frontier: number;
  sequence: number;
  recordedAt: string;
  metric: LiveMetricMessage;
}

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addSchema(publicSchema);
const compiledMetric = ajv.getSchema<LiveMetricMessage>(`${publicSchema.$id}#/$defs/GatewayServerMessage/oneOf/2`);
if (compiledMetric === undefined) throw new Error('Live metric schema is unavailable.');
const validMetric = compiledMetric as (value: unknown) => value is LiveMetricMessage;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function monitorLiveTelemetryKey(sessionId: string) {
  if (!isTerminalSessionId(sessionId)) throw new TypeError('Live telemetry identity is invalid.');
  return { PK: `SESSION#${sessionId}`, SK: 'LIVE_MONITOR' } as const;
}

export function isMonitorLiveTelemetry(value: unknown, sessionId: string): value is MonitorLiveTelemetry {
  if (!record(value)) return false;
  const keys = ['schemaVersion', 'sessionId', 'startedAt', 'source', 'frontier', 'sequence', 'recordedAt', 'metric'];
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key)) ||
    value.schemaVersion !== 1 ||
    !isTerminalSessionId(sessionId) ||
    value.sessionId !== sessionId ||
    !isMonitorControlTimestamp(value.startedAt) ||
    !isMonitorControlSource(value.source) ||
    !Number.isSafeInteger(value.frontier) ||
    (value.frontier as number) < 1 ||
    (value.frontier as number) > monitorRecordingLimits.maximumFrames ||
    (value.frontier as number) > monitorControlSchema.maximumCursor ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    (value.sequence as number) > (value.frontier as number) ||
    !isMonitorControlTimestamp(value.recordedAt) ||
    value.recordedAt < value.startedAt ||
    !validMetric(value.metric) ||
    value.metric.sample.at < value.startedAt ||
    value.metric.sample.at > value.recordedAt ||
    value.metric.recovery.sustainedSeconds >
      Math.floor((Date.parse(value.metric.sample.at) - Date.parse(value.startedAt)) / 1000)
  ) {
    return false;
  }
  return true;
}

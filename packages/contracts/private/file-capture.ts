import { isMonitorControlTimestamp } from './monitor-control.js';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import publicSchema from '../schemas/public.schema.json';

export interface CaptureMetricSample {
  at: string;
  values: Record<string, number>;
}
const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addSchema(publicSchema);
const validMetric = ajv.compile<CaptureMetricSample>({ $ref: `${publicSchema.$id}#/$defs/MetricSample` });

export const captureLimits = Object.freeze({
  maximumBytes: 256 * 1_024,
  maximumFileBytes: 16 * 1_024,
  maximumPaths: 20,
  maximumLogLines: 200,
  maximumCaptures: 5_000,
  maximumRetainedBytes: 20_000_000,
  maximumReadMs: 4_000,
  root: '/opsreplay/watched',
  baselinePath: '/v1/captures/baseline',
  capturePath: '/v1/captures',
});
export interface CaptureRequest {
  commandId: string;
  commandSeq: number;
}
export interface FileCapture {
  schemaVersion: 1;
  commandId: string;
  commandSeq: number;
  sequence: number;
  baselineAt: string;
  startedAt: string;
  completedAt: string;
  files: { path: string; before: string | null; after: string | null }[];
  logs: { path: string; lines: string[] }[];
  metrics: CaptureMetricSample | null;
  incomplete: boolean;
}
export interface CaptureBaseline {
  baselineAt: string;
  incomplete: boolean;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
export function isWatchedPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 300 &&
    /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(value) &&
    value.split('/').every((part) => part !== '.' && part !== '..')
  );
}
export function isCaptureRequest(value: unknown): value is CaptureRequest {
  return (
    record(value) &&
    exact(value, ['commandId', 'commandSeq']) &&
    typeof value.commandId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.commandId) &&
    Number.isSafeInteger(value.commandSeq) &&
    (value.commandSeq as number) >= 1 &&
    (value.commandSeq as number) <= 5_000
  );
}
export function isCaptureBaseline(value: unknown): value is CaptureBaseline {
  return (
    record(value) &&
    exact(value, ['baselineAt', 'incomplete']) &&
    isMonitorControlTimestamp(value.baselineAt) &&
    typeof value.incomplete === 'boolean'
  );
}
export function isFileCapture(value: unknown): value is FileCapture {
  if (
    !record(value) ||
    !exact(value, [
      'schemaVersion',
      'commandId',
      'commandSeq',
      'sequence',
      'baselineAt',
      'startedAt',
      'completedAt',
      'files',
      'logs',
      'metrics',
      'incomplete',
    ]) ||
    value.schemaVersion !== 1 ||
    !isCaptureRequest({ commandId: value.commandId, commandSeq: value.commandSeq }) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    (value.sequence as number) > 5_000 ||
    !isMonitorControlTimestamp(value.baselineAt) ||
    !isMonitorControlTimestamp(value.startedAt) ||
    !isMonitorControlTimestamp(value.completedAt) ||
    value.baselineAt > value.startedAt ||
    value.startedAt > value.completedAt ||
    typeof value.incomplete !== 'boolean' ||
    (value.metrics === null
      ? !value.incomplete
      : !validMetric(value.metrics) ||
        !isMonitorControlTimestamp(value.metrics.at) ||
        value.metrics.at > value.completedAt) ||
    !Array.isArray(value.files) ||
    value.files.length > 20 ||
    !Array.isArray(value.logs) ||
    value.logs.length > 20 ||
    value.files.length + value.logs.length > 20 ||
    Buffer.byteLength(JSON.stringify(value)) > captureLimits.maximumBytes
  )
    return false;
  const content = (v: unknown) =>
    v === null || (typeof v === 'string' && Buffer.byteLength(v) <= captureLimits.maximumFileBytes);
  return (
    value.files.every(
      (v) =>
        record(v) &&
        exact(v, ['path', 'before', 'after']) &&
        isWatchedPath(v.path) &&
        content(v.before) &&
        content(v.after),
    ) &&
    value.logs.every(
      (v) =>
        record(v) &&
        exact(v, ['path', 'lines']) &&
        isWatchedPath(v.path) &&
        Array.isArray(v.lines) &&
        v.lines.length <= 200 &&
        v.lines.every((line) => typeof line === 'string') &&
        Buffer.byteLength(v.lines.join('\n')) <= captureLimits.maximumFileBytes,
    )
  );
}

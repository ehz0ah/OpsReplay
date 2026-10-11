import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import publicSchema from '../schemas/public.schema.json';
import { isMonitorControlTimestamp } from './monitor-control.js';

export const commandEvidenceLimits = Object.freeze({
  maximumCommands: 5_000,
  maximumTextCharacters: 4_000,
  maximumEventBytes: 16 * 1_024,
  maximumPageCommands: 20,
  maximumPageBytes: 256 * 1_024,
  maximumControlCharacters: 21_360,
  maximumRetainedBytes: 20_000_000,
});

export interface CommandEvidence {
  id: string;
  at: string;
  kind: 'command';
  seq: number;
  endedAt: string | null;
  command: string;
  exitStatus: number | null;
  source: 'learner' | 'assistant';
  proposalId?: string;
  changedFiles: string[];
  outputExcerpt: string;
  outputTruncated: boolean;
  metrics: null;
}

export interface CommandParserCheckpoint {
  schemaVersion: 1;
  source: string;
  cursor: number;
  count: number;
  retainedBytes: number;
  lossAt: string | null;
  mode: 'text' | 'escape' | 'csi' | 'osc' | 'discard_osc' | 'discard_csi';
  control: string;
  utf8Tail: string;
  idle: boolean;
  inputLine: string;
  active: {
    event: CommandEvidence;
    marked: boolean;
    fullScreen: boolean;
  } | null;
}

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addSchema(publicSchema);
const validateEvent = ajv.getSchema(`${publicSchema.$id}#/$defs/TimelineEvent/oneOf/0`);
if (!validateEvent) throw new Error('Command schema is unavailable.');

export function isCommandEvidence(value: unknown): value is CommandEvidence {
  return validateEvent!(value) && Buffer.byteLength(JSON.stringify(value)) <= commandEvidenceLimits.maximumEventBytes;
}
export function commandId(source: string, seq: number): string {
  const bytes = createHash('sha256').update(`command:${source}:${seq}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function initialCommandParser(source: string): CommandParserCheckpoint {
  return {
    schemaVersion: 1,
    source,
    cursor: 0,
    count: 0,
    retainedBytes: 0,
    lossAt: null,
    mode: 'text',
    control: '',
    utf8Tail: '',
    idle: false,
    inputLine: '',
    active: null,
  };
}

export function isCommandParserCheckpoint(value: unknown): value is CommandParserCheckpoint {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as CommandParserCheckpoint;
  const exact = (object: object, keys: string[]) =>
    Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key));
  if (
    !exact(v, [
      'schemaVersion',
      'source',
      'cursor',
      'count',
      'retainedBytes',
      'lossAt',
      'mode',
      'control',
      'utf8Tail',
      'idle',
      'inputLine',
      'active',
    ])
  )
    return false;
  if (
    v.schemaVersion !== 1 ||
    typeof v.source !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v.source) ||
    !Number.isSafeInteger(v.cursor) ||
    v.cursor < 0 ||
    v.cursor > 100_000 ||
    !Number.isSafeInteger(v.count) ||
    v.count < 0 ||
    v.count > commandEvidenceLimits.maximumCommands ||
    !Number.isSafeInteger(v.retainedBytes) ||
    v.retainedBytes < 0 ||
    v.retainedBytes > commandEvidenceLimits.maximumRetainedBytes ||
    (v.lossAt !== null && !isMonitorControlTimestamp(v.lossAt)) ||
    !['text', 'escape', 'csi', 'osc', 'discard_osc', 'discard_csi'].includes(v.mode) ||
    typeof v.control !== 'string' ||
    v.control.length > commandEvidenceLimits.maximumControlCharacters ||
    typeof v.utf8Tail !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.utf8Tail) ||
    Buffer.from(v.utf8Tail, 'base64').length > 3 ||
    typeof v.idle !== 'boolean' ||
    typeof v.inputLine !== 'string' ||
    Array.from(v.inputLine).length > commandEvidenceLimits.maximumTextCharacters
  )
    return false;
  return (
    v.active === null ||
    (typeof v.active === 'object' &&
      exact(v.active, ['event', 'marked', 'fullScreen']) &&
      isCommandEvidence(v.active.event) &&
      v.active.event.seq === v.count &&
      v.active.event.id === commandId(v.source, v.count) &&
      v.active.event.endedAt === null &&
      v.active.event.exitStatus === null &&
      typeof v.active.marked === 'boolean' &&
      typeof v.active.fullScreen === 'boolean')
  );
}

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import publicSchema from '../schemas/public.schema.json';
import { isMonitorControlSource, isMonitorControlTimestamp, monitorControlSchema } from './monitor-control.js';

export interface MonitorEvidenceEvent {
  id: string;
  at: string;
  kind: 'monitor';
  signal: 'outage_started' | 'outage_ended' | 'recovery_sustaining' | 'recovery_lost' | 'recovered';
  label: string;
}
/** Small durable event projection committed with each live Monitor page. Partial
 * finalisation can retain known events without reading expired provisional objects. */
export interface MonitorEvidencePage {
  schemaVersion: 1;
  source: string;
  after: number;
  nextSequence: number;
  events: { sequence: number; recordedAt: string; event: MonitorEvidenceEvent }[];
}
const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addSchema(publicSchema);
const validEvent = ajv.getSchema(`${publicSchema.$id}#/$defs/TimelineEvent/oneOf/1`)!;
export function isMonitorEvidencePage(value: unknown): value is MonitorEvidencePage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as MonitorEvidencePage;
  const keys = ['schemaVersion', 'source', 'after', 'nextSequence', 'events'];
  if (
    Object.keys(v).length !== keys.length ||
    !keys.every((k) => Object.hasOwn(v, k)) ||
    v.schemaVersion !== 1 ||
    !isMonitorControlSource(v.source) ||
    !Number.isSafeInteger(v.after) ||
    v.after < 0 ||
    !Number.isSafeInteger(v.nextSequence) ||
    v.nextSequence <= v.after ||
    v.nextSequence > 10000 ||
    v.nextSequence - v.after > monitorControlSchema.maximumFramesPerPage ||
    !Array.isArray(v.events) ||
    v.events.length > v.nextSequence - v.after ||
    Buffer.byteLength(JSON.stringify(v)) > 64 * 1024
  )
    return false;
  let previous = v.after;
  return v.events.every((item) => {
    if (
      item === null ||
      typeof item !== 'object' ||
      Object.keys(item).length !== 3 ||
      !['sequence', 'recordedAt', 'event'].every((k) => Object.hasOwn(item, k)) ||
      !Number.isSafeInteger(item.sequence) ||
      item.sequence <= previous ||
      item.sequence > v.nextSequence ||
      !isMonitorControlTimestamp(item.recordedAt) ||
      !validEvent(item.event) ||
      item.event.at > item.recordedAt
    )
      return false;
    previous = item.sequence;
    return true;
  });
}

import { isMonitorControlTimestamp } from '../../contracts/private/monitor-control.js';
export function historyKey(owner: string, kind: 'session' | 'review', at: string, id: string) {
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(owner) ||
    !isMonitorControlTimestamp(at) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
  )
    throw new Error('Invalid history identity.');
  return { PK: `USER#${owner}`, SK: `HISTORY#${kind}#${at}#${id}` };
}
export interface HistoryReference {
  schemaVersion: 1;
  id: string;
  at: string;
}
export function isHistoryReference(value: unknown): value is HistoryReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as HistoryReference;
  return (
    Object.keys(v).length === 3 &&
    v.schemaVersion === 1 &&
    isMonitorControlTimestamp(v.at) &&
    typeof v.id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.id)
  );
}

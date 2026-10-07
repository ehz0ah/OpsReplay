export const unfinishedWorkIndex = Object.freeze({
  name: 'unfinished-work',
  partitionKey: 'WorkPK',
  sortKey: 'WorkSK',
  recordingPartition: 'RECORDING',
});

export const recordingWorkTiming = Object.freeze({
  // The monitor must remain reachable while the gateway drains and seals the
  // recording after the session ends. Future outcome writers must keep
  // drainDeadlineAt within this window.
  postSessionWindowMs: 60_000,
});

const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface RecordingWorkIdentity {
  sessionId: string;
  workOrder: string;
}

export function recordingWorkOrder(availableAt: string, sessionId: string): string {
  if (
    !timestampPattern.test(availableAt) ||
    !Number.isFinite(Date.parse(availableAt)) ||
    !sessionIdPattern.test(sessionId)
  ) {
    throw new Error('Invalid recording work identity');
  }
  return `${availableAt}#SESSION#${sessionId}`;
}

export function parseRecordingWorkOrder(value: unknown): RecordingWorkIdentity | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)#SESSION#([0-9a-f-]{36})$/.exec(value);
  if (!match) return undefined;
  try {
    if (recordingWorkOrder(match[1]!, match[2]!) !== value) return undefined;
  } catch {
    return undefined;
  }
  return { sessionId: match[2]!, workOrder: value };
}

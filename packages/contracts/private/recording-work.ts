export const unfinishedWorkIndex = Object.freeze({
  name: 'unfinished-work',
  partitionKey: 'WorkPK',
  sortKey: 'WorkSK',
  recordingPartition: 'RECORDING',
});

export const recordingWorkTiming = Object.freeze({
  certificateHeadroomMs: 60_000,
});

const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

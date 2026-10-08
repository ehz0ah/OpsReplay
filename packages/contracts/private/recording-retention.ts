export const recordingRetention = Object.freeze({
  tagKey: 'opsreplay-retention',
  provisionalTagValue: 'provisional',
  sealedTagValue: 'sealed',
  provisionalDays: 7,
  sealedDays: 30,
});

export type RecordingRetentionClass = 'provisional' | 'sealed';

export function recordingRetainUntil(anchor: string, retentionClass: RecordingRetentionClass): string {
  const anchorMs = Date.parse(anchor);
  if (!Number.isFinite(anchorMs)) throw new Error('Invalid recording retention anchor');
  const days = retentionClass === 'provisional' ? recordingRetention.provisionalDays : recordingRetention.sealedDays;
  return new Date(anchorMs + days * 24 * 60 * 60 * 1_000).toISOString();
}

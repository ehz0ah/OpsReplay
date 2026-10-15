import type { ApiClient } from '../api.js';
import { ApiError } from '../api.js';
import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import { pause } from '../lifecycle.js';
export async function savedDebrief(api: ApiClient, id: string, signal: AbortSignal, wait = pause) {
  for (;;) {
    signal.throwIfAborted();
    try {
      const value = await api.read('Debrief', `/v1/sessions/${id}/debrief`, signal);
      if (value.sessionId !== id) throw new Error('The debrief does not match this attempt.');
      return value;
    } catch (error) {
      if (!(error instanceof ApiError) || error.detail.code !== 'DEBRIEF_PENDING') throw error;
      await wait((error.detail.retryAfterSeconds ?? 3) * 1000, signal);
    }
  }
}
export async function playbackPage(api: ApiClient, id: string, signal: AbortSignal, cursor: string | null = null) {
  const value = await api.read(
    'Playback',
    `/v1/sessions/${id}/playback?limit=25${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
    signal,
  );
  if (value.sessionId !== id) throw new Error('The recording does not match this attempt.');
  if (cursor !== null && value.nextCursor === cursor) throw new Error('Recording cursor did not advance.');
  return value;
}
export function appendPlayback(
  current: PublicTypes['Playback'],
  page: PublicTypes['Playback'],
): PublicTypes['Playback'] {
  if (
    current.sessionId !== page.sessionId ||
    current.recording.status !== page.recording.status ||
    current.recording.reason !== page.recording.reason ||
    JSON.stringify(current.highlights) !== JSON.stringify(page.highlights)
  )
    throw new Error('Recording snapshot changed. Refresh links.');
  const combined = {
    sessionId: current.sessionId,
    recording: current.recording,
    highlights: current.highlights,
    expiresAt: Date.parse(page.expiresAt) < Date.parse(current.expiresAt) ? page.expiresAt : current.expiresAt,
    terminal: [...current.terminal, ...page.terminal],
    metrics: [...current.metrics, ...page.metrics],
    captures: [...current.captures, ...page.captures],
    nextCursor: page.nextCursor,
  };
  // Aggregate limits follow source event/metric/capture bounds, not per-page array limits.
  if (combined.terminal.length > 100000 || combined.metrics.length > 10000 || combined.captures.length > 5000)
    throw new Error('Recording reference limit exceeded.');
  return combined;
}

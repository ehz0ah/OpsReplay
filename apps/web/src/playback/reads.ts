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
export async function playbackPages(api: ApiClient, id: string, signal: AbortSignal) {
  let cursor: string | null = null,
    combined: PublicTypes['Playback'] | null = null;
  const cursors = new Set<string>();
  for (let page = 0; page < 300; page++) {
    const value: PublicTypes['Playback'] = await api.read(
      'Playback',
      `/v1/sessions/${id}/playback?limit=25${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
      signal,
    );
    if (value.sessionId !== id) throw new Error('The recording does not match this attempt.');
    if (combined) {
      if (
        JSON.stringify(value.recording) !== JSON.stringify(combined.recording) ||
        JSON.stringify(value.highlights) !== JSON.stringify(combined.highlights)
      )
        throw new Error('Recording snapshot changed. Refresh links.');
      combined = {
        sessionId: combined.sessionId,
        highlights: combined.highlights,
        recording: combined.recording,
        expiresAt: Date.parse(value.expiresAt) < Date.parse(combined.expiresAt) ? value.expiresAt : combined.expiresAt,
        terminal: [...combined.terminal, ...value.terminal],
        metrics: [...combined.metrics, ...value.metrics],
        captures: [...combined.captures, ...value.captures],
        nextCursor: value.nextCursor,
      };
    } else combined = value;
    if (combined.terminal.length > 500 || combined.metrics.length > 500 || combined.captures.length > 5000)
      throw new Error('Recording reference limit exceeded.');
    if (value.nextCursor === null) return combined;
    if (cursors.has(value.nextCursor)) throw new Error('Recording cursor did not advance.');
    cursors.add(value.nextCursor);
    cursor = value.nextCursor;
  }
  throw new Error('Recording page limit exceeded.');
}

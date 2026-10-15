import type { ApiClient } from '../api.js';
import { ApiError } from '../api.js';
import { pause, retryDelay } from '../lifecycle.js';
import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
export async function observeTimeline(
  api: ApiClient,
  id: string,
  signal: AbortSignal,
  update: (items: PublicTypes['TimelineEvent'][], error: Error | null) => void,
  wait = pause,
) {
  let cursor: string | null = null,
    failures = 0;
  while (!signal.aborted) {
    let delay = 5000;
    try {
      const page: PublicTypes['TimelinePage'] = await api.read(
        'TimelinePage',
        `/v1/sessions/${id}/timeline?limit=100${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
        signal,
      );
      if (signal.aborted) return;
      update(page.items, null);
      failures = 0;
      const advanced = page.nextCursor !== cursor;
      cursor = page.nextCursor;
      if (advanced && page.items.length === 100) delay = 250;
    } catch (value) {
      if (signal.aborted) return;
      const error = value instanceof Error ? value : new Error('Timeline is unavailable.');
      update([], error);
      if (error instanceof ApiError && [401, 403, 404, 410].includes(error.status)) return;
      if (error instanceof ApiError && error.detail.code === 'INVALID_CURSOR') cursor = null;
      delay = retryDelay(error, ++failures);
    }
    try {
      await wait(delay, signal);
    } catch {
      return;
    }
  }
}

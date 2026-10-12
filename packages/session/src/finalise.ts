import { deriveDebrief, type Debrief, type DebriefManifest } from './debrief.js';
import type { RecordedEvidence } from './recorded-evidence.js';
import { playbackHighlights, type PlaybackHighlight } from './playback-highlights.js';
import type { SessionRecord } from '../../../apps/api/src/start-session/types.js';

/** Ordinary shared code. Result publication does not depend on playback export. */
export function createFinaliseSession({
  store,
  manifest,
  evidence,
}: {
  store: {
    saved(id: string, signal?: AbortSignal): Promise<Debrief | undefined>;
    commit(
      session: SessionRecord,
      debrief: Debrief,
      signal?: AbortSignal,
      highlights?: PlaybackHighlight[],
    ): Promise<Debrief>;
  };
  manifest(session: SessionRecord, signal?: AbortSignal): Promise<DebriefManifest>;
  evidence(session: SessionRecord, signal?: AbortSignal): Promise<RecordedEvidence>;
}) {
  return async (session: SessionRecord, signal?: AbortSignal): Promise<void> => {
    if (await store.saved(session.view.id, signal)) return;
    const content = await manifest(session, signal);
    const recorded = await evidence(session, signal);
    const debrief = deriveDebrief(content, session, recorded.commands, recorded.events, recorded.counters);
    await store.commit(session, debrief, signal, playbackHighlights(debrief, recorded));
  };
}

import { deriveDebrief, type Debrief, type DebriefManifest } from './debrief.js';
import type { RecordedEvidence } from './recorded-evidence.js';
import type { SessionRecord } from '../../../apps/api/src/start-session/types.js';

/** Ordinary shared code, not a Lambda call. Cleanup is committed before this runs. */
export function createFinaliseSession({
  store,
  manifest,
  evidence,
}: {
  store: {
    saved(id: string, signal?: AbortSignal): Promise<Debrief | undefined>;
    commit(session: SessionRecord, debrief: Debrief, signal?: AbortSignal): Promise<Debrief>;
  };
  manifest(session: SessionRecord, signal?: AbortSignal): Promise<DebriefManifest>;
  evidence(session: SessionRecord, signal?: AbortSignal): Promise<RecordedEvidence>;
}) {
  return async (session: SessionRecord, signal?: AbortSignal): Promise<void> => {
    if (await store.saved(session.view.id, signal)) return;
    const content = await manifest(session, signal);
    const recorded = await evidence(session, signal);
    await store.commit(
      session,
      deriveDebrief(content, session, recorded.commands, recorded.events, recorded.counters),
      signal,
    );
  };
}

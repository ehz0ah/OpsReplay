import { RecordedEvidenceReader } from '../../../../packages/session/src/recorded-evidence.js';
import { isMonitorRecordingState } from '../../../../packages/contracts/private/monitor-persistence.js';
import { canonicalJson } from '../../../../packages/session/src/canonical.js';
import { createResultReadAction, pageInput, ResultReadError, type ResultReader } from '../result-reads/shared.js';
import {
  decodeCursor,
  encodeCursor,
  decodeTimelineCursor,
  encodeTimelineCursor,
  snapshotCursor,
} from '../result-reads/cursor.js';

export function createListTimelineHandler(
  store: ResultReader,
  evidence: RecordedEvidenceReader,
  log?: Parameters<typeof createResultReadAction>[3],
  now = Date.now,
) {
  return createResultReadAction(
    'list_timeline',
    '/v1/sessions/{id}/timeline',
    async ({ id, owner, signal, event }) => {
      const input = pageInput(event, 100);
      const session = await store.owned(id, owner, signal);
      const live = ['provisioning', 'ready'].includes(session.view.status);
      if (!live) await store.debrief(session, signal);
      const recording = await store.get(id, 'RECORDING', signal);
      if (
        session.view.readyAt &&
        (!isMonitorRecordingState(recording, id) || recording.status !== session.view.recording.status)
      )
        throw new Error('Invalid timeline recording.');
      if (isMonitorRecordingState(recording, id) && recording.retainUntil && now() >= Date.parse(recording.retainUntil))
        throw new ResultReadError('RECORDING_EXPIRED');
      const saved = await evidence.readTimeline(session, signal);
      const items: { id: string; at: string; kind: string; status?: string; reason?: string | null }[] = [
        ...saved.commands.filter((v) => v.at >= session.view.readyAt! && (live || v.at <= session.view.endedAt!)),
        ...saved.events,
        { id: `${id}:created`, at: session.view.createdAt, kind: 'lifecycle', status: 'provisioning', reason: null },
        ...(session.view.readyAt
          ? [{ id: `${id}:ready`, at: session.view.readyAt, kind: 'lifecycle', status: 'ready', reason: null }]
          : []),
        ...(!live
          ? [
              {
                id: `${id}:outcome`,
                at: session.view.endedAt!,
                kind: 'lifecycle',
                status: session.view.status,
                reason: session.view.statusReason,
              },
            ]
          : []),
      ];
      // Assistance is committed while the session is ready. A delayed recovery observation can later
      // establish an earlier measurement cutoff, but it must not erase the action that already occurred.
      items.push(
        ...(await store.assistance(id, signal)).filter(
          (v) => v.at >= session.view.createdAt && (session.view.endsAt === null || v.at < session.view.endsAt),
        ),
      );
      const compare = (a: { at: string; id: string }, b: { at: string; id: string }) =>
        a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      items.sort(compare);
      if (new Set(items.map((v) => v.id)).size !== items.length) throw new Error('Duplicate timeline event.');
      if (!live && canonicalJson(await store.get(id, 'RECORDING', signal)) !== canonicalJson(recording))
        throw new ResultReadError('INVALID_CURSOR');
      const snapshot = snapshotCursor(
        live
          ? {
              id,
              createdAt: session.view.createdAt,
              readyAt: session.view.readyAt,
              source: isMonitorRecordingState(recording, id) ? recording.source : null,
            }
          : { session: session.view, recording, items },
      );
      const after = live ? decodeTimelineCursor(input.cursor, id, snapshot) : undefined;
      const offset = live
        ? after
          ? items.findIndex((item) => compare(item, after) > 0)
          : 0
        : decodeCursor(input.cursor, id, snapshot);
      const start = offset === -1 ? items.length : offset;
      if (offset > items.length) throw new ResultReadError('INVALID_CURSOR');
      const selected = [];
      let bytes = 0;
      for (const item of items.slice(start, start + input.limit)) {
        const size = Buffer.byteLength(JSON.stringify(item)) + 1;
        if (bytes + size > 240 * 1024) break;
        selected.push(item);
        bytes += size;
      }
      if (!selected.length && start < items.length) throw new Error('Timeline event too large.');
      const end = start + selected.length;
      const last = selected.at(-1);
      return {
        items: selected,
        nextCursor: live
          ? last
            ? encodeTimelineCursor(id, snapshot, { at: last.at, id: last.id })
            : (input.cursor ?? null)
          : end < items.length
            ? encodeCursor(id, snapshot, end)
            : null,
      };
    },
    log,
  );
}

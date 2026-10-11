import type { SessionView } from '../start-session/types.js';
import { validView } from '../start-session/validation.js';

// Every nested object is projected explicitly. Never spread a private record into a response.
export function publicView(view: SessionView): SessionView {
  const {
    id,
    challenge,
    attempt,
    status,
    statusReason,
    alert,
    dashboard,
    recovery,
    timeLimitSeconds,
    createdAt,
    readyAt,
    endsAt,
    endedAt,
    hints,
    assistance,
    debriefAvailable,
    recording,
  } = view;
  const result = {
    id,
    challenge: {
      id: challenge.id,
      version: challenge.version,
      title: challenge.title,
      tier: challenge.tier,
      category: challenge.category,
    },
    attempt: { kind: attempt.kind, number: attempt.number },
    status,
    statusReason,
    alert: { title: alert.title, summary: alert.summary, severity: alert.severity },
    dashboard: dashboard.map(({ id, label, unit }) => ({ id, label, unit })),
    recovery:
      recovery === null
        ? null
        : {
            state: recovery.state,
            sustainedSeconds: recovery.sustainedSeconds,
            requiredSeconds: recovery.requiredSeconds,
          },
    timeLimitSeconds,
    createdAt,
    readyAt,
    endsAt,
    endedAt,
    hints: {
      released: hints.released.map(({ id, text, releasedAt }) => ({ id, text, releasedAt })),
      remaining: hints.remaining,
      nextAvailableAt: hints.nextAvailableAt,
    },
    assistance: {
      hintsReleased: assistance.hintsReleased,
      assistantTurns: assistance.assistantTurns,
      proposalsRun: assistance.proposalsRun,
    },
    debriefAvailable,
    recording: { status: recording.status, reason: recording.reason },
  };
  if (!validView(result)) throw new Error('Invalid session projection');
  return result;
}

import type { Evidence, LogicalEvent, SessionView } from '@opsreplay/contracts';

export function collectedObservations(session: SessionView, events: LogicalEvent[]): Evidence[] {
  const observations = new Map<string, Evidence>();
  for (const event of events)
    for (const observation of event.observations)
      observations.set(observation.observationId, observation);
  for (const observation of session.revealedEvidence)
    observations.set(observation.observationId, observation);
  return [...observations.values()].sort((a, b) => a.observedTick - b.observedTick);
}

import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
type Event = PublicTypes['TimelineEvent'];
export function mergeTimeline(current: Event[], incoming: Event[], limit = 500): Event[] {
  const rows = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) {
    const previous = rows.get(event.id);
    if (previous?.kind === 'command' && event.kind === 'command' && previous.endedAt && !event.endedAt) continue;
    rows.set(event.id, event);
  }
  return [...rows.values()]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))
    .slice(-limit);
}
export function mergeSamples(
  current: PublicTypes['MetricSample'][],
  incoming: PublicTypes['MetricSample'],
  limit = 120,
) {
  const rows = new Map(current.map((sample) => [sample.at, sample]));
  rows.set(incoming.at, incoming);
  return [...rows.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-limit);
}
export function freshSample(sample: PublicTypes['MetricSample'] | undefined, now: number, connected: boolean) {
  return Boolean(connected && sample && now - Date.parse(sample.at) <= 15000 && now - Date.parse(sample.at) >= -5000);
}

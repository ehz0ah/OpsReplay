import { Alert, Button, Skeleton, Stack } from '@mantine/core';
import type { SessionView } from '@opsreplay/contracts';

export function duration(ticks: number, tickSeconds = 60) {
  const seconds = ticks * tickSeconds;
  return seconds % 60 === 0 ? Math.abs(seconds / 60) + ' min' : Math.abs(seconds) + ' sec';
}
export function clock(tick: number, tickSeconds = 60) {
  const seconds = Math.abs(tick * tickSeconds);
  return (
    (tick < 0 ? 'T−' : 'T+') +
    String(Math.floor(seconds / 60)).padStart(2, '0') +
    ':' +
    String(seconds % 60).padStart(2, '0')
  );
}
export function humanize(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replace(/^./, (letter) => letter.toUpperCase());
}
export function Status({ status }: { status: SessionView['status'] }) {
  const labels = { active: 'In progress', resolved: 'Resolved', failed: 'Failed', ended: 'Ended' };
  return (
    <span className={'status status-' + status}>
      <span aria-hidden="true" />
      {labels[status]}
    </span>
  );
}
export function Loading({ label = 'Loading workspace' }: { label?: string }) {
  return (
    <Stack p="xl" role="status" aria-label={label}>
      <span className="muted">{label}…</span>
      <Skeleton height={32} width="45%" />
      <Skeleton height={180} />
    </Stack>
  );
}
export function Failure({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <Alert color="red" title="Unable to load" m="lg" role="alert">
      <p>{error.message}</p>
      <Button variant="default" onClick={retry}>
        Try again
      </Button>
    </Alert>
  );
}

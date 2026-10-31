import { Button } from '@mantine/core';
export function ChallengeAdmission({ refresh }: { refresh: () => void }) {
  return (
    <aside className="notice" role="status" aria-label="Challenge availability">
      <strong>Challenges are temporarily unavailable.</strong>
      <p>
        New starts and saved start requests are paused. You can use Learn and Code Review, open an existing attempt, or
        read saved results. Pro access does not change this limit.
      </p>
      <Button variant="default" onClick={refresh}>
        Check availability
      </Button>
    </aside>
  );
}

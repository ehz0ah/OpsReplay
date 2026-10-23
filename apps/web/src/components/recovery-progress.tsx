import { Progress } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useEffect, useRef, useState } from 'react';
import type { PublicTypes } from '../../../../packages/contracts/public-types.js';

export function RecoveryProgress({
  recovery,
  running,
}: {
  recovery: NonNullable<PublicTypes['SessionView']['recovery']>;
  running: boolean;
}) {
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const target = Math.min(recovery.requiredSeconds, recovery.sustainedSeconds);
  const [display, setDisplay] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    const start = current.current;
    if (reducedMotion || !running || recovery.state !== 'sustaining' || target <= start) {
      current.current = target;
      setDisplay(target);
      return;
    }
    const started = performance.now();
    const duration = Math.min(5000, (target - start) * 1000);
    const timer = window.setInterval(() => {
      const fraction = Math.min(1, Math.max(0, performance.now() - started) / duration);
      current.current = start + (target - start) * fraction;
      setDisplay(current.current);
      if (fraction === 1) clearInterval(timer);
    }, 100);
    return () => clearInterval(timer);
  }, [target, recovery.state, running, reducedMotion]);
  // Animation follows already-confirmed time. It never predicts a successful check.
  const shown = Math.min(target, display);
  return (
    <div className="recovery-strip" role="status">
      <strong>Recovery: {recovery.state}</strong>
      <Progress
        aria-label="Sustained recovery"
        transitionDuration={reducedMotion ? 0 : 100}
        value={(shown / recovery.requiredSeconds) * 100}
        color="teal"
      />
      <span>
        {Math.floor(shown)} / {recovery.requiredSeconds}s confirmed
      </span>
      {running && recovery.state === 'sustaining' && (
        <span className="recovery-update-note">
          Recovery needs continuous successful checks. The timer follows confirmed progress.
        </span>
      )}
    </div>
  );
}

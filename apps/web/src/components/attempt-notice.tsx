/** @jsxRuntime automatic */
import { Button } from '@mantine/core';
import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import { useSession } from '../use-session.js';
import { useRead } from '../use-read.js';
import { useAuth } from '../auth/provider.js';
import { terminal } from '../lifecycle.js';
import { navigate } from '../navigation.js';
import { Failure } from './failure.js';
import { WorkingState } from './working-state.js';

export function attemptNotice(view: PublicTypes['SessionView']) {
  if (view.status === 'provisioning')
    return {
      title: 'Your environment is starting',
      detail: 'The clock starts when it is ready. Open the workspace to follow progress.',
      action: 'Open attempt',
    };
  if (view.status === 'ready')
    return {
      title: 'Your incident is still running',
      detail: 'Leaving the workspace does not pause it. Return within five minutes to avoid abandonment.',
      action: 'Resume attempt',
    };
  if (view.readyAt === null)
    return {
      title: 'Your environment did not start',
      detail: 'Open the attempt to check the outcome and cleanup before trying again.',
      action: 'Open attempt',
    };
  return {
    title: 'Your attempt has ended',
    detail: view.debriefAvailable
      ? 'Your saved debrief is ready.'
      : 'Your result is being saved and the environment is stopping.',
    action: view.debriefAvailable ? 'Open debrief' : 'View progress',
  };
}

export function ActiveAttempt({ id }: { id: string }) {
  const session = useSession(id);
  if (!session.view)
    return (
      <aside className="attempt-notice">
        {!session.error && <WorkingState title="Checking your current attempt" />}
        <Failure error={session.error} retry={session.refresh} />
        {session.error && <Button onClick={() => navigate('/sessions/' + id)}>Open attempt</Button>}
      </aside>
    );
  const notice = session.error
    ? {
        title: 'Current attempt status is unavailable',
        detail: 'Leaving the workspace does not pause an incident. Open the attempt to read its current state.',
        action: 'Open attempt',
      }
    : attemptNotice(session.view);
  return (
    <aside className="attempt-notice" aria-label="Current attempt">
      <div>
        <strong>{notice.title}</strong>
        <p>{notice.detail}</p>
        <Failure error={session.error} retry={session.refresh} />
      </div>
      <Button
        onClick={() =>
          navigate(
            '/sessions/' +
              id +
              (!session.error && terminal(session.view!.status) && session.view!.debriefAvailable ? '/debrief' : ''),
          )
        }
      >
        {notice.action}
      </Button>
    </aside>
  );
}

export function CurrentAttemptNotice() {
  const auth = useAuth();
  const account = useRead('Account', '/v1/me', Boolean(auth.identity) && !auth.loading);
  if (!auth.identity || auth.loading) return null;
  if (account.error) return <Failure error={account.error} retry={account.reload} />;
  return account.data?.activeSessionId ? (
    <ActiveAttempt key={account.data.activeSessionId} id={account.data.activeSessionId} />
  ) : null;
}

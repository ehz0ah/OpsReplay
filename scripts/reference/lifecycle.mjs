// Executable contract model, not a launcher or persistence implementation.
// Observations come from the task service and Scheduler. Times are epoch milliseconds.
export function nextStartupAction(session, observed, now) {
  if (session.status === 'provisioning') {
    if (now >= session.provisioningDeadlineAt) return { type: 'start_failed' };
    if (observed.scheduleAt !== session.provisioningDeadlineAt) {
      return { type: 'set_schedule', at: session.provisioningDeadlineAt };
    }
    if (!session.taskArn) {
      return observed.taskArn
        ? { type: 'save_task', arn: observed.taskArn }
        : { type: 'launch', arguments: session.launchArguments };
    }
    if (observed.healthy && observed.recorderAttached) return { type: 'mark_ready', readyAt: now, endsAt: now + session.timeLimitMs };
  } else if (session.status === 'ready') {
    // A timer is only a wake-up signal. The saved deadline is authoritative.
    if (now >= session.endsAt) return { type: 'time_limit' };
    if (observed.scheduleAt !== session.endsAt) return { type: 'set_schedule', at: session.endsAt };
  }
  return { type: 'wait' };
}

export function nextFinalisationAction(session, recording, observed, now) {
  if (['provisioning', 'ready'].includes(session.status)) return { type: 'wait' };
  if (recording.status === 'draining') {
    const reason = observed.taskStopped ? 'task_lost'
      : now >= recording.drainDeadlineAt ? 'drain_timeout' : null;
    return reason ? { type: 'seal_incomplete', reason } : { type: 'wait' };
  }
  if (!['complete', 'incomplete'].includes(recording.status)) throw new Error('Outcome must start a drain');
  if (!observed.taskStopped) return { type: 'stop_task' };
  if (observed.scheduleExists) return { type: 'delete_schedule' };
  return session.finalised ? { type: 'wait' } : { type: 'finalise' };
}

export function acceptRecordingComplete(recording, receipt, now) {
  if (recording.status !== 'draining' || now >= recording.drainDeadlineAt
    || now >= recording.leaseExpiresAt || receipt.generation !== recording.generation
    || !receipt.allDataSaved || receipt.hasGaps) return recording;
  return { ...recording, status: 'complete', reason: null };
}

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
    if (observed.healthy) return { type: 'mark_ready', readyAt: now, endsAt: now + session.timeLimitMs };
  } else if (session.status === 'ready') {
    // A timer is only a wake-up signal. The saved deadline is authoritative.
    if (now >= session.endsAt) return { type: 'time_limit' };
    if (observed.scheduleAt !== session.endsAt) return { type: 'set_schedule', at: session.endsAt };
  }
  return { type: 'wait' };
}

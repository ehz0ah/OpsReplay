// Executable debrief rules for contract fixtures, not a runtime recorder.
const seconds = (from, to) => (Date.parse(to) - Date.parse(from)) / 1000;
const matchesAny = (patterns, text) => patterns.some(source => new RegExp(source).test(text));

export function matchEvidence(evidence, commands) {
  const attempts = commands.filter(item => matchesAny(evidence.commandPatterns, item.command));
  const observed = attempts.find(item => item.endedAt !== null
    && evidence.outputPatterns.every(source => new RegExp(source).test(item.outputExcerpt)));
  return {
    id: evidence.id, description: evidence.description,
    status: observed ? 'observed' : attempts.length ? 'attempted' : 'not_observed',
    commandSeq: observed?.seq ?? attempts[0]?.seq ?? null,
  };
}

export function deriveDebrief(challenge, events, session) {
  if (!session.readyAt || !session.endedAt || ['provisioning', 'ready'].includes(session.status)) {
    throw new Error('Debrief requires a session that became ready and has an outcome');
  }
  const ordered = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  // Use committed boundaries even if recording loss removed lifecycle events.
  const ready = { at: session.readyAt };
  const end = { at: session.endedAt, status: session.status };
  const saved = ordered.filter(item => seconds(ready.at, item.at) >= 0 && seconds(item.at, end.at) >= 0);
  const commands = saved.filter(item => item.kind === 'command').map(item =>
    item.endedAt && seconds(item.endedAt, end.at) < 0
      ? { ...item, endedAt: null, outputExcerpt: '' } : item);
  const outages = [];
  for (const event of saved.filter(item => item.kind === 'monitor')) {
    if (event.signal === 'outage_started') outages.push({ label: event.label, startedAt: event.at, endedAt: null });
    if (event.signal === 'outage_ended') {
      const outage = outages.findLast(item => item.label === event.label && item.endedAt === null);
      if (outage) outage.endedAt = event.at;
    }
  }
  const keyEvidence = challenge.debrief.keyEvidence.map(item => matchEvidence(item, commands));
  const possibleHarmfulActions = challenge.traps.flatMap(trap => {
    const label = challenge.healthProbes.find(item => item.id === trap.probe).publicLabel;
    return commands.flatMap(command => {
      if (!matchesAny(trap.commandPatterns, command.command)) return [];
      const outage = outages.find(item => item.label === label
        && seconds(command.at, item.startedAt) >= 0 && seconds(command.at, item.startedAt) <= trap.withinSeconds);
      return outage ? [{ id: trap.id, description: trap.description, commandSeq: command.seq, outageStartedAt: outage.startedAt }] : [];
    });
  });
  const recoveryStart = saved.findLast(item => item.kind === 'monitor' && item.signal === 'recovery_sustaining');
  const recovered = end.status === 'resolved' && saved.some(item => item.kind === 'monitor' && item.signal === 'recovered');
  return {
    keyEvidence, possibleHarmfulActions, outages,
    timeToRecoverySeconds: recovered && recoveryStart ? seconds(ready.at, recoveryStart.at) : null,
    commandCount: commands.length,
    observedOutages: outages.length,
    outageSeconds: outages.reduce((sum, item) => sum + seconds(item.startedAt, item.endedAt ?? end.at), 0),
    recoveryStart: recovered ? recoveryStart : null,
  };
}

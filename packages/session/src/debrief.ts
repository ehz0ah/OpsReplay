import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import publicSchema from '../../contracts/schemas/public.schema.json';
import challengeSchema from '../../contracts/schemas/challenge.schema.json';
import { isCommandEvidence, type CommandEvidence } from '../../contracts/private/command-evidence.js';
import { matchesCommand } from './command-match.mjs';
import type { SessionRecord, SessionView } from '../../../apps/api/src/start-session/types.js';

export interface DebriefManifest {
  id: string;
  version: string;
  hints: { id: string; text: string; minElapsedMinutes: number }[];
  provenance: { sources: { title: string; url: string }[] };
  healthProbes: { id: string; publicLabel: string }[];
  traps: { id: string; description: string; probe: string; commandPatterns: string[]; withinSeconds: number }[];
  debrief: {
    rootCause: string;
    causalChain: string[];
    keyEvidence: { id: string; description: string; commandPatterns: string[]; outputPatterns: string[] }[];
    recommendedRecovery: string[];
  };
}
export interface DebriefMonitorEvent {
  id: string;
  at: string;
  kind: 'monitor';
  signal: 'outage_started' | 'outage_ended' | 'recovery_sustaining' | 'recovery_lost' | 'recovered';
  label: string;
}
export interface Debrief {
  sessionId: string;
  challenge: SessionView['challenge'];
  attempt: SessionView['attempt'];
  outcome: 'resolved' | 'failed' | 'ended' | 'abandoned' | 'error';
  rootCause: string;
  causalChain: string[];
  keyEvidence: {
    id: string;
    description: string;
    status: 'observed' | 'attempted' | 'not_observed';
    commandSeq: number | null;
  }[];
  possibleHarmfulActions: { id: string; description: string; commandSeq: number; outageStartedAt: string }[];
  outages: { label: string; startedAt: string; endedAt: string | null }[];
  recommendedRecovery: string[];
  sources: DebriefManifest['provenance']['sources'];
  score: {
    timeToRecoverySeconds: number | null;
    totalRequests: number;
    failedRequests: number;
    commandCount: number;
    observedOutages: number;
    outageSeconds: number;
  } | null;
  assisted: boolean;
  assistance: SessionView['assistance'];
  recording: { status: 'complete' | 'incomplete'; reason: string | null };
}
const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addSchema(publicSchema);
const validDebrief = ajv.compile<Debrief>({ $ref: `${publicSchema.$id}#/$defs/Debrief` });
const validMonitor = ajv.getSchema(`${publicSchema.$id}#/$defs/TimelineEvent/oneOf/1`)!;
const validChallenge = ajv.compile<DebriefManifest>(challengeSchema);
const elapsed = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 1000;
const match = (patterns: string[], text: string) => patterns.some((source) => new RegExp(source).test(text));
export function isDebrief(value: unknown): value is Debrief {
  return validDebrief(value);
}
export function isDebriefManifest(value: unknown): value is DebriefManifest {
  return validChallenge(value);
}

/** Pure reflection derivation. The pinned manifest supplies explanations, not
 * live effects. Monitor observations alone supply recovery and service impact. */
export function deriveDebrief(
  manifest: DebriefManifest,
  session: SessionRecord,
  commands: readonly CommandEvidence[],
  events: readonly DebriefMonitorEvent[],
  counters: { totalRequests: number; failedRequests: number } | null,
): Debrief {
  const view = session.view;
  if (
    !isDebriefManifest(manifest) ||
    !view.readyAt ||
    !view.endedAt ||
    ['ready', 'provisioning'].includes(view.status) ||
    !['complete', 'incomplete'].includes(view.recording.status) ||
    manifest.id !== view.challenge.id ||
    manifest.version !== view.challenge.version ||
    commands.length > 5000 ||
    commands.some((command) => !isCommandEvidence(command)) ||
    events.length > 10_000 ||
    events.some((event) => !validMonitor(event))
  )
    throw new Error('Invalid debrief inputs.');
  const inBounds = (at: string) => elapsed(view.readyAt!, at) >= 0 && elapsed(at, view.endedAt!) >= 0;
  const saved = [...commands]
    .filter((item) => inBounds(item.at))
    .sort((a, b) => a.seq - b.seq)
    .map((item) =>
      item.endedAt !== null && !inBounds(item.endedAt)
        ? { ...item, endedAt: null, exitStatus: null, outputExcerpt: '' }
        : item,
    );
  if (new Set(saved.map((item) => item.seq)).size !== saved.length) throw new Error('Duplicate debrief command.');
  const monitor = [...events].filter((item) => inBounds(item.at)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const outages: Debrief['outages'] = [];
  for (const event of monitor) {
    if (event.signal === 'outage_started') outages.push({ label: event.label, startedAt: event.at, endedAt: null });
    else if (event.signal === 'outage_ended') {
      const outage = [...outages].reverse().find((item) => item.label === event.label && item.endedAt === null);
      if (outage) outage.endedAt = event.at;
    }
  }
  const keyEvidence: Debrief['keyEvidence'] = manifest.debrief.keyEvidence.map((evidence) => {
    const attempts = saved.filter((command) => matchesCommand(evidence.commandPatterns, command.command));
    const observed = attempts.find(
      (command) =>
        command.endedAt !== null &&
        evidence.outputPatterns.every((pattern) => new RegExp(pattern).test(command.outputExcerpt)),
    );
    return {
      id: evidence.id,
      description: evidence.description,
      status: observed ? 'observed' : attempts.length ? 'attempted' : 'not_observed',
      commandSeq: observed?.seq ?? attempts[0]?.seq ?? null,
    };
  });
  const possible: Debrief['possibleHarmfulActions'] = [];
  for (const trap of manifest.traps) {
    const probe = manifest.healthProbes.find((probe) => probe.id === trap.probe);
    if (!probe) throw new Error('Invalid trap probe.');
    for (const command of saved) {
      if (!match(trap.commandPatterns, command.command)) continue;
      const outage = outages.find(
        (item) =>
          item.label === probe.publicLabel &&
          elapsed(command.at, item.startedAt) >= 0 &&
          elapsed(command.at, item.startedAt) <= trap.withinSeconds,
      );
      if (outage && possible.length < 50)
        possible.push({
          id: trap.id,
          description: trap.description,
          commandSeq: command.seq,
          outageStartedAt: outage.startedAt,
        });
    }
  }
  if (view.recording.status === 'complete' && counters === null)
    throw new Error('Complete debrief requires measured counters.');
  const incomplete = view.recording.status === 'incomplete';
  const sustaining = [...monitor].reverse().find((item) => item.signal === 'recovery_sustaining');
  const recovered = view.status === 'resolved' && monitor.some((item) => item.signal === 'recovered');
  const result: Debrief = {
    sessionId: view.id,
    challenge: structuredClone(view.challenge),
    attempt: { ...view.attempt },
    outcome: view.status as Debrief['outcome'],
    rootCause: manifest.debrief.rootCause,
    causalChain: [...manifest.debrief.causalChain],
    keyEvidence,
    possibleHarmfulActions: possible.slice(0, 50),
    outages: outages.slice(0, 50),
    recommendedRecovery: [...manifest.debrief.recommendedRecovery],
    sources: structuredClone(manifest.provenance.sources),
    score: incomplete
      ? null
      : {
          timeToRecoverySeconds: recovered && sustaining ? elapsed(view.readyAt, sustaining.at) : null,
          ...counters!,
          commandCount: saved.length,
          observedOutages: outages.length,
          outageSeconds: outages.reduce(
            (sum, outage) => sum + elapsed(outage.startedAt, outage.endedAt ?? view.endedAt!),
            0,
          ),
        },
    assisted: Object.values(view.assistance).some((value) => value > 0),
    assistance: { ...view.assistance },
    recording: incomplete
      ? { status: 'incomplete', reason: view.recording.reason ?? 'data_gap' }
      : { status: 'complete', reason: null },
  };
  if (!isDebrief(result) || Buffer.byteLength(JSON.stringify(result)) > 256 * 1024)
    throw new Error('Invalid derived debrief.');
  return result;
}

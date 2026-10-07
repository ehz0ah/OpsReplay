import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import SwaggerParser from '@apidevtools/swagger-parser';
import { deriveDebrief } from './reference/debrief.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);

function valid(validate, value, label) {
  assert.ok(validate(value), label + ': ' + JSON.stringify(validate.errors));
}
const unique = (values, label) => assert.equal(new Set(values).size, values.length, 'Duplicate ' + label);
const seconds = (from, to) => (Date.parse(to) - Date.parse(from)) / 1000;

// Public wire types and examples.
const publicSchema = read('packages/contracts/schemas/public.schema.json');
ajv.addSchema(publicSchema);
const validateType = (name) => ajv.getSchema(publicSchema.$id + '#/$defs/' + name);
for (const name of Object.keys(publicSchema.$defs)) assert.ok(validateType(name), 'Uncompiled public schema ' + name);
const example = (file) => read('packages/contracts/examples/' + file);
const typedExamples = [
  ['catalog.json', 'Catalog'],
  ['start-session-request.json', 'StartSessionRequest'],
  ['session.json', 'SessionView'],
  ['timeline.json', 'TimelinePage'],
  ['debrief.json', 'Debrief'],
  ['playback.json', 'Playback'],
  ['review-exercise.json', 'ReviewExercise'],
  ['review-submit-request.json', 'ReviewSubmitRequest'],
  ['review-submission.json', 'ReviewSubmission'],
];
for (const [file, type] of typedExamples) valid(validateType(type), example(file), file);
for (const [type, values] of Object.entries(example('response-examples.json'))) {
  for (const [index, value] of values.entries()) valid(validateType(type), value, type + ' example ' + index);
}
const gateway = example('gateway-messages.json');
for (const message of gateway.client)
  valid(validateType('GatewayClientMessage'), message, 'Client frame ' + message.type);
for (const message of gateway.server)
  valid(validateType('GatewayServerMessage'), message, 'Server frame ' + message.type);

// Private fields must not fit public shapes.
const session = example('session.json');
assert.equal(
  validateType('SessionView')({ ...session, plantedFault: 'hidden' }),
  false,
  'Private session field accepted',
);
assert.equal(validateType('SessionView')({ ...session, taskAddress: '10.0.1.7' }), false, 'Task address accepted');
const leakingExercise = { ...example('review-exercise.json'), findings: [] };
assert.equal(validateType('ReviewExercise')(leakingExercise), false, 'Review findings accepted before submission');
assert.equal(
  validateType('GatewayClientMessage')({ type: 'input', data: 'ls' }),
  false,
  'Terminal input must use binary frames',
);
const incompleteDebrief = example('response-examples.json').Debrief[0];
assert.equal(
  validateType('Debrief')({ ...incompleteDebrief, score: example('debrief.json').score }),
  false,
  'Incomplete recording must not carry a numeric score',
);
assert.equal(
  validateType('Playback')({ ...example('playback.json'), recording: { status: 'draining', reason: null } }),
  false,
  'Playback cannot expose an unsealed recording',
);
const completedTurn = example('response-examples.json').Turn[0];
assert.equal(
  validateType('Turn')({ ...completedTurn, status: 'interrupted' }),
  false,
  'Interrupted turns cannot expose runnable proposals',
);
assert.equal(
  validateType('Turn')({ ...completedTurn, workerToken: 'private' }),
  false,
  'Worker token must not be public',
);
assert.equal(
  validateType('Proposal')({ ...completedTurn.proposals[0], status: 'run' }),
  false,
  'A database write cannot claim a command ran',
);
assert.equal(
  validateType('Proposal')({ ...completedTurn.proposals[0], deliveryToken: 'private' }),
  false,
  'Delivery tokens must not be public',
);
valid(
  validateType('ScoreComponents'),
  { ...example('debrief.json').score, outageSeconds: 99.75 },
  'Fractional monitor duration',
);

// OpenAPI.
function rewrite(value) {
  if (Array.isArray(value)) return value.map(rewrite);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === '$ref' ? item.replace('#/$defs/', '#/components/schemas/') : rewrite(item),
      ]),
    );
  return value;
}
const api = read('packages/contracts/openapi.json');
assert.deepEqual(
  api.components.schemas,
  rewrite(publicSchema.$defs),
  'Run npm run contracts:sync after public schema changes',
);
await SwaggerParser.validate(path.join(root, 'packages/contracts/openapi.json'));
const apiDoc = fs.readFileSync(path.join(root, 'docs/api.md'), 'utf8');
let routeCount = 0;
for (const [route, methods] of Object.entries(api.paths)) {
  for (const method of Object.keys(methods)) {
    routeCount++;
    assert.ok(apiDoc.includes(method.toUpperCase() + ' ' + route), 'Undocumented route: ' + method + ' ' + route);
  }
}
for (const message of [
  ...publicSchema.$defs.GatewayClientMessage.oneOf,
  ...publicSchema.$defs.GatewayServerMessage.oneOf,
]) {
  assert.ok(
    apiDoc.includes('`' + message.properties.type.const + '`'),
    'Undocumented gateway frame: ' + message.properties.type.const,
  );
}

// Challenge manifests.
const validateChallenge = ajv.compile(read('packages/contracts/schemas/challenge.schema.json'));
const pattern = (source) => new RegExp(source);
const matchesAny = (patterns, command) => patterns.some((source) => pattern(source).test(command));
const challenges = new Map();
for (const entry of fs.readdirSync(path.join(root, 'content/challenges'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = 'content/challenges/' + entry.name + '/challenge.json';
  const manifest = read(file);
  valid(validateChallenge, manifest, file);
  assert.equal(manifest.id, entry.name, file + ': directory must match id');
  const journeys = new Set(manifest.traffic.journeys.map((item) => item.id));
  const probes = new Set(manifest.healthProbes.map((item) => item.id));
  unique(
    manifest.traffic.journeys.map((item) => item.id),
    'journey in ' + file,
  );
  unique(
    manifest.validators.map((item) => item.id),
    'validator in ' + file,
  );
  unique(
    manifest.healthProbes.map((item) => item.id),
    'probe in ' + file,
  );
  unique(
    manifest.healthProbes.map((item) => item.publicLabel),
    'probe label in ' + file,
  );
  unique(
    manifest.traps.map((item) => item.id),
    'trap in ' + file,
  );
  unique(
    manifest.hints.map((item) => item.id),
    'hint in ' + file,
  );
  unique(
    manifest.dashboard.map((item) => item.id),
    'dashboard metric in ' + file,
  );
  unique(
    manifest.debrief.keyEvidence.map((item) => item.id),
    'key evidence in ' + file,
  );
  unique(
    manifest.environment.services.map((item) => item.name),
    'service in ' + file,
  );
  for (const check of [...manifest.validators, ...manifest.healthProbes].map((item) => item.check)) {
    if (check.kind === 'journey') assert.ok(journeys.has(check.journey), file + ': unknown journey ' + check.journey);
  }
  const serviceFiles = new Set(manifest.environment.services.flatMap((item) => item.configFiles));
  for (const target of manifest.plantedFault.files)
    assert.ok(serviceFiles.has(target), file + ': fault file is not a watched config file: ' + target);
  for (const hint of manifest.hints.slice(1).map((item, index) => [manifest.hints[index], item])) {
    assert.ok(hint[1].minElapsedMinutes >= hint[0].minElapsedMinutes, file + ': hints must release in order');
  }
  for (const source of [
    ...manifest.traps.flatMap((item) => item.commandPatterns),
    ...manifest.debrief.keyEvidence.flatMap((item) => [...item.commandPatterns, ...item.outputPatterns]),
  ]) {
    assert.doesNotThrow(() => pattern(source), file + ': invalid evidence or command pattern ' + source);
  }
  for (const trap of manifest.traps) {
    assert.ok(probes.has(trap.probe), file + ': trap uses unknown probe ' + trap.probe);
    assert.ok(
      trap.commands.some((command) => matchesAny(trap.commandPatterns, command)),
      file + ': scripted trap ' + trap.id + ' would not be detected',
    );
    for (const command of [...manifest.referenceFix.commands, ...(trap.safeAlternative?.commands ?? [])]) {
      if (trap.commands.includes(command)) continue;
      assert.ok(
        !matchesAny(trap.commandPatterns, command),
        file + ': trap ' + trap.id + ' pattern matches a safe command: ' + command,
      );
    }
  }
  if (manifest.status === 'published') {
    assert.ok(
      manifest.environment.image.digest && manifest.environment.monitorImage.digest,
      file + ': published Challenges pin image digests',
    );
    if (manifest.provenance.kind === 'adapted')
      assert.ok(manifest.provenance.sources.length > 0, file + ': adapted content needs sources');
  }
  challenges.set(manifest.id, manifest);
}
assert.ok(challenges.size > 0, 'No Challenge manifests found');

// Code Review bundles and the reference line-range matcher.
const validateReview = ajv.compile(read('packages/contracts/schemas/review.schema.json'));
const reviews = new Map();
for (const entry of fs.readdirSync(path.join(root, 'content/reviews'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = 'content/reviews/' + entry.name + '/review.json';
  const bundle = read(file);
  valid(validateReview, bundle, file);
  assert.equal(bundle.id, entry.name, file + ': directory must match id');
  unique(
    bundle.files.map((item) => item.path),
    'diff file in ' + file,
  );
  unique(
    bundle.findings.map((item) => item.id),
    'finding in ' + file,
  );
  for (const diff of bundle.files) {
    for (const line of diff.lines) {
      assert.equal(line.oldLine === null, line.kind === 'added', file + ': added lines have no old number');
      assert.equal(line.newLine === null, line.kind === 'removed', file + ': removed lines have no new number');
    }
  }
  for (const finding of bundle.findings) {
    const diff = bundle.files.find((item) => item.path === finding.file);
    assert.ok(diff, file + ': finding in unknown file ' + finding.file);
    assert.ok(finding.startLine <= finding.endLine, file + ': inverted range ' + finding.id);
    const numbers = new Set(diff.lines.map((line) => (finding.side === 'new' ? line.newLine : line.oldLine)));
    for (let line = finding.startLine; line <= finding.endLine; line++) {
      assert.ok(numbers.has(line), file + ': finding ' + finding.id + ' covers a line not in the diff');
    }
  }
  for (const id of bundle.relatedChallenges) assert.ok(challenges.has(id), file + ': unknown related Challenge ' + id);
  reviews.set(bundle.id, bundle);
}
function matchReview(bundle, flags) {
  const matched = new Set();
  const findings = bundle.findings.map((finding) => {
    const matchedFlags = flags.flatMap((flag, index) =>
      flag.file === finding.file &&
      flag.side === finding.side &&
      flag.line >= finding.startLine &&
      flag.line <= finding.endLine
        ? [index]
        : [],
    );
    matchedFlags.forEach((index) => matched.add(index));
    return { ...finding, found: matchedFlags.length > 0, matchedFlags };
  });
  return {
    findings,
    unmatchedFlags: flags.map((_, index) => index).filter((index) => !matched.has(index)),
    summary: {
      found: findings.filter((item) => item.found).length,
      missed: findings.filter((item) => !item.found).length,
    },
  };
}
const exercise = example('review-exercise.json');
const bundle = reviews.get(exercise.id);
assert.ok(bundle, 'Review exercise example has no bundle');
const {
  findings: _hidden,
  schemaVersion: _schemaVersion,
  status: _status,
  summary: _summary,
  provenance: _provenance,
  relatedChallenges: _relatedChallenges,
  ...projection
} = bundle;
assert.deepEqual(exercise, projection, 'Review exercise must be the bundle without private fields');
const submitRequest = example('review-submit-request.json');
const submission = example('review-submission.json');
assert.deepEqual(submission.flags, submitRequest.flags);
const { findings, unmatchedFlags, summary: matchSummary } = submission;
assert.deepEqual(
  { findings, unmatchedFlags, summary: matchSummary },
  matchReview(bundle, submitRequest.flags),
  'Review matching differs from the reference rule',
);
for (const [index, flag] of submitRequest.flags.entries()) {
  const diff = bundle.files.find((item) => item.path === flag.file);
  assert.ok(
    diff && diff.lines.some((line) => (flag.side === 'new' ? line.newLine : line.oldLine) === flag.line),
    'Flag ' + index + ' is not on a diff line',
  );
}

// Catalogue and session examples agree with private content without exposing it.
for (const item of example('catalog.json').items) {
  const source = item.mode === 'challenge' ? challenges.get(item.id) : reviews.get(item.id);
  assert.ok(source, 'Catalogue entry without content: ' + item.id);
  for (const key of ['version', 'title', 'summary', 'category', 'plan', 'tier', 'language']) {
    if (key in item || key in source) assert.equal(item[key], source[key], item.id + ' catalogue ' + key);
  }
}
const manifest = challenges.get(session.challenge.id);
const challengeRef = {
  id: manifest.id,
  version: manifest.version,
  title: manifest.title,
  tier: manifest.tier,
  category: manifest.category,
};
assert.deepEqual(session.challenge, challengeRef);
assert.deepEqual(session.alert, manifest.alert);
assert.deepEqual(
  session.dashboard,
  manifest.dashboard.map(({ id, label, unit }) => ({ id, label, unit })),
);
assert.equal(session.recovery.requiredSeconds, Math.max(...manifest.validators.map((item) => item.sustainSeconds)));
assert.equal(session.hints.released.length + session.hints.remaining, manifest.hints.length);
const nextHint = manifest.hints[session.hints.released.length];
assert.equal(
  seconds(session.readyAt, session.hints.nextAvailableAt),
  nextHint.minElapsedMinutes * 60,
  'Hint availability counts from readiness',
);
assert.equal(
  session.timeLimitSeconds,
  manifest.environment.timeLimitMinutes * 60,
  'Free-plan limit comes from the manifest',
);
assert.equal(
  seconds(session.readyAt, session.endsAt),
  session.timeLimitSeconds,
  'The time limit starts when the terminal is ready',
);
for (const hint of example('response-examples.json').HintResponse.map((item) => item.hint)) {
  assert.ok(
    [...challenges.values()].some((item) =>
      item.hints.some((entry) => entry.id === hint.id && entry.text === hint.text),
    ),
    'Unknown hint example',
  );
}

// Reference debrief derivation from a recorded timeline.
const timeline = example('timeline.json');
const debrief = example('debrief.json');
const playback = example('playback.json');
assert.equal(timeline.nextCursor, null, 'The debrief fixture needs the complete timeline');
const sorted = [...timeline.items].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
assert.deepEqual(timeline.items, sorted, 'Timeline events are in time order');
unique(
  timeline.items.map((item) => item.id),
  'timeline event ID',
);
const commandEvents = timeline.items.filter((item) => item.kind === 'command');
assert.deepEqual(
  commandEvents.map((item) => item.seq),
  commandEvents.map((_, index) => index + 1),
  'Command sequence numbers are contiguous',
);
const timelineChallenge = challenges.get(debrief.challenge.id);
const derived = deriveDebrief(timelineChallenge, timeline.items, {
  readyAt: session.readyAt,
  endedAt: timeline.items.at(-1).at,
  status: debrief.outcome,
});
assert.deepEqual(debrief.keyEvidence, derived.keyEvidence, 'Debrief key evidence');
assert.deepEqual(debrief.possibleHarmfulActions, derived.possibleHarmfulActions, 'Debrief harmful actions');
assert.deepEqual(debrief.outages, derived.outages, 'Debrief outages');
for (const key of ['timeToRecoverySeconds', 'commandCount', 'observedOutages', 'outageSeconds']) {
  assert.equal(debrief.score[key], derived[key], 'Debrief score ' + key);
}
assert.ok(debrief.score.failedRequests <= debrief.score.totalRequests);
for (const key of ['rootCause', 'causalChain', 'recommendedRecovery'])
  assert.deepEqual(debrief[key], timelineChallenge.debrief[key]);
assert.equal(debrief.outcome, timeline.items.at(-1).status);
assert.equal(debrief.assisted, Object.values(debrief.assistance).some(Boolean));
const expectedHighlights = [
  ...derived.keyEvidence
    .filter((item) => item.status === 'observed')
    .map((item) => ({
      kind: 'key_evidence',
      at: commandEvents[item.commandSeq - 1].at,
      commandSeq: item.commandSeq,
      label: item.description,
    })),
  ...derived.possibleHarmfulActions.map((item) => ({
    kind: 'possible_harmful_action',
    at: commandEvents[item.commandSeq - 1].at,
    commandSeq: item.commandSeq,
    label: item.description,
  })),
  ...derived.outages.map((item) => ({ kind: 'outage', at: item.startedAt, commandSeq: null, label: item.label })),
  ...(derived.recoveryStart
    ? [{ kind: 'recovery', at: derived.recoveryStart.at, commandSeq: null, label: derived.recoveryStart.label }]
    : []),
].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
assert.deepEqual(playback.highlights, expectedHighlights, 'Playback highlights follow the debrief');
assert.deepEqual(
  playback.captures.map((item) => item.commandSeq),
  commandEvents.map((item) => item.seq),
  'One capture per command',
);
let previousCaptureStart = null;
for (const capture of playback.captures) {
  const command = commandEvents.find((item) => item.seq === capture.commandSeq);
  if (previousCaptureStart) {
    assert.equal(
      Date.parse(capture.baselineAt),
      Date.parse(previousCaptureStart),
      'Capture interval includes prior non-atomic reads',
    );
  } else {
    assert.ok(
      Date.parse(capture.baselineAt) <= Date.parse(session.readyAt),
      'Initial baseline starts before readiness',
    );
  }
  assert.ok(Date.parse(capture.baselineAt) <= Date.parse(capture.startedAt), 'Capture baseline after its start');
  assert.ok(
    Date.parse(command.endedAt) <= Date.parse(capture.startedAt),
    'Capture cannot precede its requesting command end',
  );
  assert.ok(Date.parse(capture.startedAt) <= Date.parse(capture.completedAt), 'Inverted capture interval');
  previousCaptureStart = capture.startedAt;
}
assert.equal(playback.sessionId, debrief.sessionId);

// Markdown links and style.
function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', '.git'].includes(entry.name)) return [];
    const location = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(location) : [location];
  });
}
const markdown = walk(root).filter((file) => file.endsWith('.md'));
for (const file of markdown) {
  const content = fs.readFileSync(file, 'utf8');
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^(https?:|mailto:)/.test(target)) continue;
    assert.ok(
      fs.existsSync(path.resolve(path.dirname(file), target)),
      'Broken link in ' + path.relative(root, file) + ': ' + target,
    );
  }
  assert.ok(!content.includes('—'), 'Em dash in ' + file);
}
console.log(
  'PASS: OpenAPI with ' +
    routeCount +
    ' routes, ' +
    Object.keys(publicSchema.$defs).length +
    ' public schemas, ' +
    challenges.size +
    ' Challenge manifests, ' +
    reviews.size +
    ' review bundle, examples, debrief and review-matching fixtures, ' +
    'leakage cases, and ' +
    markdown.length +
    ' Markdown files.',
);
console.log(
  'This check covers contracts and reference models only. Run npm run challenge:test for the local image, npm run monitor:test and npm run monitor:image:test for the monitor, npm run gateway:test and npm run gateway:image:test for the gateway monitor client, npm run api:test for session provisioning, and npm run infra:test for CDK definitions. The gateway service, UI, remaining API routes, and AWS integration remain unimplemented.',
);

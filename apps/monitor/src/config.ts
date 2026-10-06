import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import schema from '../../../packages/contracts/schemas/challenge.schema.json';
import { MonitorError, limits } from './types.js';
import type { Journey, MonitorConfig, Probe, Validator } from './types.js';

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
addFormats(ajv);
interface Manifest {
  environment: { timeLimitMinutes: number };
  traffic: { journeys: Journey[] };
  validators: Validator[];
  healthProbes: Probe[];
}
const validate = ajv.compile<Manifest>(schema);
const invalid = (): never => { throw new MonitorError('invalid_config'); };
export function validHost(host: string): boolean {
  return /^127\.0\.0\.(0|[1-9][0-9]{0,2})$/.test(host) && Number(host.split('.')[3]) <= 255;
}
export function endpoint(value: string): URL {
  try {
    const url = new URL(value);
    const authoredHost = value.match(/^http:\/\/(127\.0\.0\.[0-9]+)/)?.[1];
    if (!/^http:\/\/127\.0\.0\.[0-9]+(?::[0-9]+)?(?:\/|$)/.test(value)
      || !validHost(url.hostname) || authoredHost !== url.hostname || url.username || url.password || url.hash
      || /[\u0000-\u0020\u007f]/.test(value) || (url.port && Number(url.port) < 1)) invalid();
    return url;
  } catch { return invalid(); }
}
function unique(ids: string[]) { if (new Set(ids).size !== ids.length) invalid(); }
export function parseConfig(text: string): MonitorConfig {
  if (Buffer.byteLength(text) > limits.manifestBytes) invalid();
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return invalid(); }
  if (!validate(raw)) return invalid();
  const { journeys } = raw.traffic;
  unique(journeys.map(j => j.id));
  unique(raw.validators.map(v => v.id));
  unique(raw.healthProbes.map(p => p.id));
  unique(raw.healthProbes.map(p => p.publicLabel));
  for (const journey of journeys) for (const step of journey.steps) endpoint(step.url);
  for (const validator of raw.validators) {
    const check = validator.check;
    if (check.kind === 'journey') {
      if (!journeys.some(j => j.id === check.journey)) invalid();
    } else if (check.kind === 'checkout') endpoint(check.baseUrl);
    else invalid();
  }
  for (const probe of raw.healthProbes) {
    if (probe.check.kind !== 'tcp' || !validHost(probe.check.host)) invalid();
  }
  // Admission is bounded by the worst-case journey duration, not normal latency.
  const concurrency = journeys.reduce((n, j) => n + 1 + Math.ceil(j.ratePerSecond
    * j.steps.reduce((ms, s) => ms + s.timeoutMs, 0) / 1000), 0);
  const requestRate = journeys.reduce((n, j) => n + j.ratePerSecond * j.steps.length, 0);
  const durationMs = raw.environment.timeLimitMinutes * 60_000;
  const maximumRecords = Math.ceil(requestRate * durationMs / 1000) + concurrency;
  if (requestRate > 20 || maximumRecords > limits.requestRecords
    || concurrency + raw.validators.length + raw.healthProbes.length + 1 > limits.inFlight) invalid();
  // Project only execution configuration. The monitor retains no root cause or hints.
  return structuredClone({ durationMs, journeys, validators: raw.validators, probes: raw.healthProbes });
}

import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import { parsePublic } from '../../../../packages/contracts/public-validation.js';
export function assetUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    !/^([a-z0-9.-]+\.)?s3(?:\.[a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname)
  )
    throw new Error('Invalid recording object URL.');
  return url.href;
}
export class AssetExpired extends Error {
  constructor() {
    super('Recording links expired. Refresh links and try again.');
  }
}
export async function readAsset(
  url: string,
  signal: AbortSignal,
  maximum: number,
  transport: typeof fetch = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await transport(assetUrl(url), {
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    });
  } catch {
    throw new Error('The recording object could not be read.');
  }
  if (response.status === 403) throw new AssetExpired();
  if (!response.ok) throw new Error('The recording object is unavailable.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The recording object is empty.');
  let bytes = 0,
    text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximum) {
        await reader.cancel();
        throw new Error('Recording object exceeds its size limit.');
      }
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
export type CastEvent = { at: number; type: 'o' | 'i' | 'r' | 'm'; value: string };
export function parseCast(text: string, track: PublicTypes['PlaybackTrack']) {
  const lines = text.trimEnd().split('\n');
  if (lines.length > 105) throw new Error('Invalid terminal chunk.');
  const header = JSON.parse(lines.shift() ?? 'null');
  const start = Date.parse(track.startedAt),
    end = Date.parse(track.endedAt);
  if (
    !header ||
    Object.keys(header).sort().join(',') !== 'duration,height,timestamp,version,width' ||
    header.version !== 2 ||
    ![header.width, header.height].every((value) => Number.isInteger(value) && value >= 1 && value <= 500) ||
    header.timestamp !== start / 1000 ||
    header.duration !== (end - start) / 1000
  )
    throw new Error('Invalid terminal header.');
  let previous = start;
  const events = lines.map((line) => {
    const value: unknown = JSON.parse(line);
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      typeof value[0] !== 'number' ||
      !Number.isFinite(value[0]) ||
      value[0] < 0 ||
      !['o', 'i', 'r', 'm'].includes(value[1]) ||
      typeof value[2] !== 'string'
    )
      throw new Error('Invalid terminal event.');
    const at = start + value[0] * 1000;
    if (at < previous || at > end) throw new Error('Invalid terminal timestamp.');
    previous = at;
    if (value[1] === 'r' && !/^(?:[1-9][0-9]{0,2})x(?:[1-9][0-9]{0,2})$/.test(value[2]))
      throw new Error('Invalid terminal dimensions.');
    if (value[1] === 'r' && value[2].split('x').some((v: string) => Number(v) > 500))
      throw new Error('Invalid terminal dimensions.');
    return { at, type: value[1], value: value[2] } as CastEvent;
  });
  return { width: header.width as number, height: header.height as number, events };
}
export async function metricSamples(text: string, track: PublicTypes['PlaybackTrack']) {
  const object = await parsePublic('PlaybackMetrics', JSON.parse(text));
  const samples: PublicTypes['MetricSample'][] = [];
  let previous = Date.parse(track.startedAt),
    sequence = 0,
    source: string | null = null;
  for (const frame of object.frames) {
    const at = Date.parse(frame.recordedAt);
    if (
      at < previous ||
      at > Date.parse(track.endedAt) ||
      frame.sequence <= sequence ||
      (source !== null && source !== frame.source)
    )
      throw new Error('Invalid metric recording order.');
    previous = at;
    sequence = frame.sequence;
    source = frame.source;
    if (frame.payload.type === 'metrics') {
      if (Date.parse(frame.payload.sample.at) > at) throw new Error('Invalid metric sample time.');
      samples.push(frame.payload.sample);
    } else if (frame.payload.type !== 'timeline' || frame.payload.event.kind !== 'monitor')
      throw new Error('Invalid metric recording payload.');
  }
  if (object.final) {
    if (object.final.type !== 'metrics' || object.final.sample.at !== track.endedAt)
      throw new Error('Invalid final metric.');
    samples.push(object.final.sample);
  }
  return samples;
}
export async function captureObject(text: string, reference: PublicTypes['Playback']['captures'][number]) {
  const value = await parsePublic('PlaybackCapture', JSON.parse(text));
  if (
    value.commandSeq !== reference.commandSeq ||
    value.baselineAt !== reference.baselineAt ||
    value.startedAt !== reference.startedAt ||
    value.completedAt !== reference.completedAt ||
    Date.parse(value.baselineAt) > Date.parse(value.startedAt) ||
    Date.parse(value.startedAt) > Date.parse(value.completedAt) ||
    value.files.length + value.logs.length > 20 ||
    (value.unavailable && !value.incomplete)
  )
    throw new Error('The capture does not match its saved interval.');
  return value;
}

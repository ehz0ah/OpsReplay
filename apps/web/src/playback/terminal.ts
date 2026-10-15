import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import { parseCast, readAsset } from './assets.js';
import { pause } from '../lifecycle.js';
export async function replayTerminal(
  tracks: PublicTypes['PlaybackTrack'][],
  signal: AbortSignal,
  sink: {
    resize: (cols: number, rows: number) => void;
    write: (value: string) => Promise<void>;
    time: (at: number) => void;
  },
  from = 0,
  read = readAsset,
  wait = pause,
) {
  let previous: number | null = null;
  for (let index = 0; index < tracks.length; index++) {
    signal.throwIfAborted();
    const track = tracks[index]!;
    if (previous !== null && Date.parse(track.startedAt) < previous) throw new Error('Terminal chunks overlap.');
    const cast = parseCast(await read(track.url, signal, 256 * 1024), track);
    signal.throwIfAborted();
    if (index === 0) sink.resize(cast.width, cast.height);
    for (const event of cast.events) {
      signal.throwIfAborted();
      if (previous !== null && event.at > from)
        await wait(Math.max(0, event.at - Math.max(previous, from)) / 4, signal);
      signal.throwIfAborted();
      if (event.type === 'o') await sink.write(event.value);
      else if (event.type === 'r') {
        const [cols, rows] = event.value.split('x').map(Number);
        sink.resize(cols!, rows!);
      }
      signal.throwIfAborted();
      previous = event.at;
      sink.time(event.at);
    }
    previous = Date.parse(track.endedAt);
  }
}

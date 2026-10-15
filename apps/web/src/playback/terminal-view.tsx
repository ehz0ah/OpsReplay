import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import { replayTerminal } from './terminal.js';
import { Failure } from '../components/failure.js';
export default function RecordedTerminal({
  tracks,
  highlights,
  onTime,
}: {
  tracks: PublicTypes['PlaybackTrack'][];
  highlights: PublicTypes['Playback']['highlights'];
  onTime: (at: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    term = useRef<Terminal | null>(null),
    controller = useRef<AbortController | null>(null),
    time = useRef(onTime);
  time.current = onTime;
  const [playing, setPlaying] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [from, setFrom] = useState('0');
  useEffect(() => {
    const terminal = new Terminal({
      disableStdin: true,
      scrollback: 5000,
      fontSize: 13,
      theme: { background: '#101416', foreground: '#e6eceb' },
    });
    terminal.open(host.current!);
    term.current = terminal;
    return () => {
      controller.current?.abort();
      term.current = null;
      terminal.dispose();
    };
  }, []);
  async function play() {
    if (playing || !term.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setPlaying(true);
    setError(null);
    term.current.reset();
    try {
      await replayTerminal(
        tracks,
        abort.signal,
        {
          resize: (cols, rows) => term.current?.resize(cols, rows),
          write: (value) =>
            new Promise((resolve, reject) => {
              if (abort.signal.aborted) {
                resolve();
                return;
              }
              const done = () => {
                clearTimeout(timer);
                abort.signal.removeEventListener('abort', done);
                resolve();
              };
              const timer = setTimeout(() => {
                abort.signal.removeEventListener('abort', done);
                reject(new Error('Playback output timed out.'));
              }, 5000);
              abort.signal.addEventListener('abort', done, { once: true });
              term.current?.write(value, done);
            }),
          time: (at) => time.current(at),
        },
        Number(from),
      );
    } catch (value) {
      if (!abort.signal.aborted) setError(value instanceof Error ? value : new Error('Playback failed.'));
    } finally {
      if (!abort.signal.aborted) setPlaying(false);
    }
  }
  return (
    <section className="terminal-panel">
      <div className="terminal-heading">
        <h2>Recorded terminal</h2>
        <span className="badge">Read only · 4× speed</span>
      </div>
      <div className="actions">
        <label>
          Start at
          <select value={from} disabled={playing} onChange={(event) => setFrom(event.target.value)}>
            <option value="0">Beginning</option>
            {highlights.map((item, index) => (
              <option key={index} value={String(Date.parse(item.at))}>
                {new Date(item.at).toLocaleTimeString()} {item.label}
              </option>
            ))}
          </select>
        </label>
        <button disabled={playing || tracks.length === 0} onClick={() => void play()}>
          Replay
        </button>
        <button
          className="secondary"
          disabled={!playing}
          onClick={() => {
            controller.current?.abort();
            setPlaying(false);
          }}
        >
          Stop
        </button>
      </div>
      <Failure error={error} />
      <div ref={host} className="terminal-host" aria-label="Recorded terminal output" />
    </section>
  );
}

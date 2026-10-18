import { Button, NativeSelect } from '@mantine/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import { TerminalRecording, terminalRange } from './terminal.js';
import { PlaybackPlayer, playbackSpeeds, type PlayerState } from './player.js';
import { Failure } from '../components/failure.js';
export default function RecordedTerminal({
  tracks,
  highlights,
  range: availableRange,
  prepare,
  onState,
  seek,
}: {
  tracks: PublicTypes['PlaybackTrack'][];
  highlights: PublicTypes['Playback']['highlights'];
  range?: import('./terminal.js').PlaybackRange | null;
  prepare?: (at: number, signal: AbortSignal) => Promise<void>;
  onState?: (state: PlayerState) => void;
  seek?: { at: number } | null;
}) {
  const host = useRef<HTMLDivElement>(null),
    player = useRef<PlaybackPlayer | null>(null),
    prepareTime = useRef(prepare),
    observe = useRef(onState),
    position = useRef<number | null>(null),
    rate = useRef(1);
  prepareTime.current = prepare;
  observe.current = onState;
  const sourceRange = useMemo(() => {
    try {
      return { range: terminalRange(tracks), error: null };
    } catch (value) {
      return { range: null, error: value instanceof Error ? value : new Error('Invalid terminal recording.') };
    }
  }, [tracks]);
  const range = availableRange === undefined ? sourceRange.range : availableRange;
  const evidence = highlights.filter(
    (item) => range && Date.parse(item.at) >= range.start && Date.parse(item.at) <= range.end,
  );
  const [state, setState] = useState<PlayerState | null>(null),
    [from, setFrom] = useState('');
  useEffect(() => {
    const terminal = new Terminal({
      disableStdin: true,
      scrollback: 5000,
      fontSize: 13,
      theme: { background: '#101416', foreground: '#e6eceb' },
    });
    terminal.open(host.current!);
    const pending = new Set<() => void>();
    if (sourceRange.error) {
      setState(null);
      return () => terminal.dispose();
    }
    const source = new TerminalRecording(tracks, {
      reset: () => terminal.reset(),
      resize: (cols, rows) => terminal.resize(cols, rows),
      write: (value) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(done);
            reject(new Error('Playback output timed out.'));
          }, 5000);
          const done = () => {
            clearTimeout(timer);
            pending.delete(done);
            resolve();
          };
          pending.add(done);
          terminal.write(value, done);
        }),
    });
    setState(null);
    if (range) {
      const control = new PlaybackPlayer(
        range,
        async (at, signal) => {
          await prepareTime.current?.(at, signal);
          await source.render(at, signal);
          signal.throwIfAborted();
        },
        (value) => {
          position.current = value.at;
          rate.current = value.speed;
          setState(value);
          observe.current?.(value);
        },
        undefined,
        position.current ?? range.start,
        rate.current,
      );
      player.current = control;
      void control.seek(position.current ?? range.start);
    }
    return () => {
      player.current?.dispose();
      player.current = null;
      terminal.dispose();
      for (const done of pending) done();
    };
  }, [tracks, sourceRange, range]);
  useEffect(() => {
    if (seek) void player.current?.seek(seek.at);
  }, [seek]);
  const playing = state?.status === 'playing',
    seeking = state?.status === 'seeking',
    at = state?.at ?? range?.start ?? 0;
  return (
    <section className="terminal-panel">
      <div className="terminal-heading">
        <h2>Recorded terminal</h2>
        <span className="badge">Read only</span>
      </div>
      <div className="playback-controls">
        <div className="actions">
          <Button
            disabled={!state || seeking}
            onClick={() => void (playing ? player.current?.pause() : player.current?.play())}
          >
            {playing ? 'Pause' : state?.status === 'ended' ? 'Replay' : 'Play'}
          </Button>
          <Button variant="default" disabled={!state} onClick={() => void player.current?.seek(range!.start)}>
            Reset
          </Button>
          <NativeSelect
            label="Speed"
            value={String(state?.speed ?? rate.current)}
            disabled={!state}
            data={playbackSpeeds.map((speed) => ({ value: String(speed), label: `${speed}×` }))}
            onChange={(event) => player.current?.setSpeed(Number(event.currentTarget.value))}
          />
          <NativeSelect
            label="Jump to evidence"
            value={from}
            disabled={!range}
            data={[
              { value: '', label: 'Select a moment' },
              ...evidence.map((item, index) => ({
                value: String(index),
                label: `${new Date(item.at).toLocaleTimeString()} ${item.label}`,
              })),
            ]}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setFrom(value);
              if (value !== '' && evidence[Number(value)])
                void player.current?.seek(Date.parse(evidence[Number(value)]!.at));
            }}
          />
        </div>
        <label className="playback-position">
          Playback position
          <input
            type="range"
            min={range?.start ?? 0}
            max={range?.end ?? 0}
            step="1"
            value={at}
            disabled={!state || range?.start === range?.end}
            aria-valuetext={new Date(at).toLocaleTimeString()}
            onChange={(event) => void player.current?.seek(Number(event.currentTarget.value))}
          />
        </label>
        {range ? (
          <p className="playback-time">
            {new Date(at).toLocaleTimeString()} / {new Date(range.end).toLocaleTimeString()}
          </p>
        ) : (
          <p>No recording tracks are loaded.</p>
        )}
        {seeking && <p role="status">Preparing this playback position…</p>}
        <Failure error={sourceRange.error ?? state?.error ?? null} />
      </div>
      <div ref={host} className="terminal-host" aria-label="Recorded terminal output" />
    </section>
  );
}

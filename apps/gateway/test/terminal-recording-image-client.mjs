import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const {
  TerminalRecordingClient,
  TerminalRecordingClientError,
  TerminalClient,
  TerminalClientError,
} = require('/test/client.cjs');
const mode = process.argv[2];
assert.ok(mode === 'normal' || mode === 'loss' || mode === 'idle');
const options = { host: '127.0.0.1', requestTimeoutMs: 5_000 };

async function interactive(generation, output) {
  return TerminalClient.connect(
    { host: '127.0.0.1', generation, columns: 100, rows: 30, onOutput: (data) => output?.append(data) },
    AbortSignal.timeout(5_000),
  );
}

function outputCollector() {
  let tail = '';
  return {
    append(data) {
      tail = (tail + data.toString()).slice(-4096);
    },
    async waitFor(marker) {
      const deadline = Date.now() + 10_000;
      while (!tail.includes(marker)) {
        assert.ok(Date.now() < deadline, 'interactive shell did not produce the expected marker');
        await delay(50);
      }
    },
  };
}

async function exit(client) {
  const input = client.input(Buffer.from('exit 7\n')).catch((error) => {
    assert.ok(error instanceof TerminalClientError && error.code === 'input_uncertain');
  });
  assert.deepEqual(await client.ended, { reason: 'exit', code: 7 });
  await input;
}

async function until(reader, after, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = await reader.read(after);
    if (predicate(page)) return page;
    await delay(150); // Stay below the source's ten reads per second.
  }
  assert.fail('terminal source did not reach the expected state');
}

async function drain(reader, expectedSource) {
  const events = [];
  let cursor = 0;
  let final;
  for (let reads = 0; reads <= 1_000; reads++) {
    final = await reader.read(cursor);
    assert.equal(final.source, expectedSource);
    assert.equal(final.shellState, 'exited');
    assert.ok(final.events.length <= 100);
    for (const event of final.events) {
      assert.equal(event.sequence, cursor + 1);
      events.push(event);
      cursor = event.sequence;
    }
    if (cursor === final.latestSequence) break;
    await delay(120);
  }
  assert.ok(final && cursor === final.latestSequence, 'bounded drain must reach the final sequence');
  assert.equal(events.at(-1).type, 'exit');
  assert.equal(events.at(-1).code, 7);
  assert.deepEqual(events[0], {
    sequence: 1,
    recordedAt: events[0].recordedAt,
    type: 'dimensions',
    columns: 80,
    rows: 24,
  });
  return { events, final };
}

async function main() {
  let recorder;
  let secondReader;
  let terminal;
  let replaced;
  try {
    const attached = await TerminalRecordingClient.connect(options, AbortSignal.timeout(5_000));
    recorder = attached.client;
    const source = attached.ready.source;
    const firstPage = await recorder.read(0);
    const prefix = firstPage.events;
    const prefixCursor = firstPage.nextSequence;
    assert.deepEqual(prefix[0], {
      sequence: 1,
      recordedAt: prefix[0].recordedAt,
      type: 'dimensions',
      columns: 80,
      rows: 24,
    });
    if (mode === 'idle') {
      // Do not read, send heartbeat traffic, or shorten the real 45-second source limit.
      const end = await recorder.ended;
      assert.equal(end.reason, 'error');
      assert.ok(end.error instanceof TerminalRecordingClientError);
      assert.equal(end.error.code, 'server_rejected');
      assert.equal(end.error.serverCode, 'IDLE_TIMEOUT');
      await assert.rejects(recorder.read(prefixCursor), (error) => error === end.error);
      recorder.close();
      assert.strictEqual(await recorder.ended, end);
      const resumed = await TerminalRecordingClient.connect({ ...options, expectedSource: source });
      recorder = resumed.client;
      assert.equal(resumed.ready.shellState, 'running');
      assert.deepEqual((await recorder.read(0)).events.slice(0, prefix.length), prefix);
      process.stdout.write(
        JSON.stringify({
          mode,
          sourceStable: true,
          code: end.error.code,
          serverCode: end.error.serverCode,
          reconnected: true,
        }) + '\n',
      );
      return;
    }
    terminal = (await interactive(1)).client;
    secondReader = (await TerminalRecordingClient.connect({ ...options, expectedSource: source })).client;
    await terminal.heartbeat();
    assert.deepEqual((await secondReader.read(0)).events.slice(0, prefix.length), prefix);

    if (mode === 'normal') {
      await terminal.resize(120, 40);
      // Disable echo so the delayed marker cannot be mistaken for the command input.
      await terminal.input(
        Buffer.from(
          "stty -echo; export RECORDING_CLIENT_STATE=preserved; (sleep 0.7; printf 'disconnected-%s\\n' 'marker') &\n",
        ),
      );
      terminal.close();
      recorder.close();
      secondReader.close();
      await delay(1_100);
      const resumed = await TerminalRecordingClient.connect({ ...options, expectedSource: source });
      recorder = resumed.client;
      const replay = await recorder.read(0);
      assert.deepEqual(replay.events.slice(0, prefix.length), prefix);
      const missing = await recorder.read(prefixCursor);
      const bytes = Buffer.concat(
        missing.events.filter((event) => event.type === 'output').map((event) => Buffer.from(event.data, 'base64')),
      ).toString();
      assert.ok(
        bytes.includes('disconnected-marker'),
        'original output must be available after all clients disconnect',
      );
      secondReader = (await TerminalRecordingClient.connect({ ...options, expectedSource: source })).client;
      assert.deepEqual((await secondReader.read(prefixCursor)).events, missing.events);
      const output = outputCollector();
      terminal = (await interactive(2, output)).client;
      await terminal.input(Buffer.from('printf \'state:%s\\n\' "$RECORDING_CLIENT_STATE"; sleep 10 &\n'));
      await output.waitFor('state:preserved');
      // A quiet background PTY holder must not cause false data_gap on Bash exit.
      await delay(150);
      await exit(terminal);
      await until(recorder, 0, (page) => page.shellState === 'exited');
      const { events, final } = await drain(recorder, source);
      assert.equal(final.loss, null);
      assert.ok(events.some((event) => event.type === 'dimensions' && event.columns === 120 && event.rows === 40));
      assert.ok(
        events.some(
          (event) => event.type === 'input' && Buffer.from(event.data, 'base64').toString().includes('stty -echo'),
        ),
      );
      assert.ok(
        Buffer.concat(
          events.filter((event) => event.type === 'output').map((event) => Buffer.from(event.data, 'base64')),
        )
          .toString()
          .includes('state:preserved'),
      );
      process.stdout.write(
        JSON.stringify({
          mode,
          sourceStable: true,
          disconnectedOutput: true,
          replayStable: true,
          exitCode: 7,
          loss: final.loss,
          events: events.length,
        }) + '\n',
      );
    } else {
      // Recording attachment must neither own nor replace the interactive generation.
      replaced = terminal;
      const output = outputCollector();
      terminal = (await interactive(2, output)).client;
      assert.equal((await replaced.ended).error.code, 'replaced');
      await terminal.input(Buffer.from("stty -echo; head -c 17000000 /dev/zero; printf 'overflow-finished\\n'\n"));
      const lossPage = await until(recorder, 0, (page) => page.loss?.reason === 'limit_exceeded');
      const frozen = lossPage.latestSequence;
      await output.waitFor('overflow-finished');
      await terminal.heartbeat();
      await terminal.input(Buffer.from("printf 'still-%s\\n' 'usable'\n"));
      await output.waitFor('still-usable');
      const after = await secondReader.read(0);
      assert.equal(after.latestSequence, frozen);
      assert.deepEqual(after.loss, lossPage.loss);
      await exit(terminal);
      const final = await until(recorder, frozen, (page) => page.shellState === 'exited');
      assert.equal(final.latestSequence, frozen + 1);
      assert.deepEqual(final.loss, lossPage.loss);
      assert.deepEqual(final.events, [
        { sequence: frozen + 1, recordedAt: final.events[0].recordedAt, type: 'exit', code: 7 },
      ]);
      assert.equal((await recorder.read(final.nextSequence)).events.length, 0);
      process.stdout.write(
        JSON.stringify({
          mode,
          sourceStable: true,
          shellUsable: true,
          prefixFrozen: true,
          exitCode: 7,
          loss: final.loss.reason,
          events: final.latestSequence,
        }) + '\n',
      );
    }
  } finally {
    recorder?.close();
    secondReader?.close();
    terminal?.close();
    replaced?.close();
  }
}

main().catch((error) => {
  const code =
    error instanceof TerminalRecordingClientError || error instanceof TerminalClientError ? error.code : 'test_failed';
  process.stderr.write(
    JSON.stringify({ error: code, message: error instanceof Error ? error.message : String(error) }) + '\n',
  );
  process.exitCode = 1;
});

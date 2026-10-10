import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { TerminalClient, TerminalClientError } = require('/test/client.cjs');

function outputCollector() {
  let value = '';
  let wake;
  return {
    append(data) {
      value += data.toString();
      wake?.();
      wake = undefined;
    },
    async waitFor(expected) {
      const deadline = Date.now() + 5_000;
      while (!value.includes(expected)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) assert.fail(`Terminal output did not contain ${expected}`);
        await Promise.race([
          new Promise((resolve) => {
            wake = resolve;
          }),
          delay(Math.min(remaining, 100)),
        ]);
      }
    },
  };
}

function terminalError(code) {
  return (error) => error instanceof TerminalClientError && error.code === code;
}

async function attach(generation, output) {
  return TerminalClient.connect(
    {
      host: '127.0.0.1',
      generation,
      columns: 100,
      rows: 30,
      onOutput: (data) => output.append(data),
      connectTimeoutMs: 2_000,
      operationTimeoutMs: 2_000,
    },
    AbortSignal.timeout(5_000),
  );
}

async function main() {
  const firstOutput = outputCollector();
  const first = await attach(1, firstOutput);
  assert.deepEqual(first.ready, { resumed: false, replayTruncated: false });

  await first.client.input(
    Buffer.from("export OPSREPLAY_TERMINAL_CLIENT_STATE=preserved; cd /tmp; printf 'gateway-first\\n'\n"),
  );
  await firstOutput.waitFor('gateway-first');

  const secondOutput = outputCollector();
  const second = await attach(2, secondOutput);
  assert.deepEqual(second.ready, { resumed: true, replayTruncated: false });
  const replaced = await first.client.ended;
  assert.equal(replaced.reason, 'error');
  if (replaced.reason === 'error') assert.equal(replaced.error.code, 'replaced');
  await assert.rejects(first.client.input(Buffer.from('printf stale\n')), terminalError('replaced'));

  await second.client.resize(120, 40);
  await second.client.heartbeat();
  await second.client.input(
    Buffer.from('printf \'gateway-second:%s:%s\\n\' "$OPSREPLAY_TERMINAL_CLIENT_STATE" "$PWD"\n'),
  );
  await secondOutput.waitFor('gateway-second:preserved:/tmp');

  const exitInput = second.client.input(Buffer.from('exit\n')).then(
    () => 'accepted',
    (error) => {
      assert.ok(terminalError('input_uncertain')(error));
      return 'uncertain';
    },
  );
  const exited = await second.client.ended;
  assert.deepEqual(exited, { reason: 'exit', code: 0 });

  process.stdout.write(
    JSON.stringify({
      firstResumed: first.ready.resumed,
      secondResumed: second.ready.resumed,
      replaced: replaced.reason === 'error',
      statePreserved: true,
      exitInput: await exitInput,
      exitCode: exited.code,
    }) + '\n',
  );
}

main().catch((error) => {
  const code = error instanceof TerminalClientError ? error.code : 'test_failed';
  process.stderr.write(
    JSON.stringify({ error: code, message: error instanceof Error ? error.message : String(error) }) + '\n',
  );
  process.exitCode = 1;
});

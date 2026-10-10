import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { GatewayTerminalSession, TerminalAdmissionError, TerminalClientError } = require('/test/client.cjs');

const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tickets = new Set(['a'.repeat(43), 'b'.repeat(43)]);
let currentInput;
const admissions = {
  async admit(request) {
    assert.equal(request.sessionId, sessionId);
    assert.ok(tickets.delete(request.ticket), 'ticket must be valid and unused');
    currentInput = {
      sessionId,
      connectionId: request.connectionId,
      generation: (currentInput?.generation ?? 0) + 1,
    };
    return { ...currentInput, taskAddress: '127.0.0.1' };
  },
  async authorizeInput(request) {
    if (
      request.sessionId !== currentInput?.sessionId ||
      request.connectionId !== currentInput.connectionId ||
      request.generation !== currentInput.generation
    ) {
      throw new TerminalAdmissionError('replaced');
    }
  },
};

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

async function attach(ticket, output) {
  return GatewayTerminalSession.open(
    {
      sessionId,
      ticket,
      columns: 100,
      rows: 30,
      onOutput: (data) => output.append(data),
    },
    { admissions },
    AbortSignal.timeout(5_000),
  );
}

async function main() {
  const firstOutput = outputCollector();
  const first = await attach('a'.repeat(43), firstOutput);
  assert.deepEqual(first.ready, {
    sessionId,
    generation: 1,
    resumed: false,
    replayTruncated: false,
  });

  await first.session.input(
    Buffer.from("export OPSREPLAY_TERMINAL_CLIENT_STATE=preserved; cd /tmp; printf 'gateway-first\\n'\n"),
  );
  await firstOutput.waitFor('gateway-first');

  const secondOutput = outputCollector();
  const second = await attach('b'.repeat(43), secondOutput);
  assert.deepEqual(second.ready, {
    sessionId,
    generation: 2,
    resumed: true,
    replayTruncated: true,
  });
  const replaced = await first.session.ended;
  assert.equal(replaced.reason, 'error');
  if (replaced.reason === 'error') assert.equal(replaced.error.code, 'replaced');
  await assert.rejects(
    first.session.input(Buffer.from('printf stale\n')),
    (error) => error instanceof TerminalAdmissionError && error.code === 'replaced',
  );

  await second.session.resize(120, 40);
  await second.session.heartbeat();
  await second.session.input(
    Buffer.from('printf \'gateway-second:%s:%s\\n\' "$OPSREPLAY_TERMINAL_CLIENT_STATE" "$PWD"\n'),
  );
  await secondOutput.waitFor('gateway-second:preserved:/tmp');

  const exitInput = second.session.input(Buffer.from('exit\n')).then(
    () => 'accepted',
    (error) => {
      assert.ok(terminalError('input_uncertain')(error));
      return 'uncertain';
    },
  );
  const exited = await second.session.ended;
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

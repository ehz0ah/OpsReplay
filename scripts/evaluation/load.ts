import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { parsePublic } from '../../packages/contracts/public-validation.js';
import { loadConfiguration, jsonRequest } from './http.js';
import { terminalProbe } from './terminal.js';
import { distribution, reserveReport } from './report.js';
export async function runLoad(input: unknown, path: string, transport = fetch, probe = terminalProbe) {
  const config = loadConfiguration(input),
    started = performance.now();
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const write = await reserveReport(path);
  const measurements: {
    worker: number;
    round: number;
    operation: string;
    passed: boolean;
    status: number | null;
    durationMs: number;
  }[] = [];
  const probes: { admissionMs: number; roundTripMs: number }[] = [];
  const lifetime = AbortSignal.timeout(
    Math.min(60 * 60_000, config.rounds * (config.timeoutMs * 5 + config.thinkTimeMs) + 10000),
  );
  await Promise.all(
    config.participants.map(async (participant, worker) => {
      for (let round = 1; round <= config.rounds && !lifetime.aborted; round++) {
        let readsPassed = true;
        for (const [operation, route, type] of [
          ['catalog', '/v1/catalog', 'Catalog'],
          ['account', '/v1/account', 'Account'],
          ['session', '/v1/sessions/' + participant.sessionId, 'SessionView'],
        ] as const) {
          const at = performance.now();
          let status: number | null = null,
            passed = false;
          try {
            const result = await jsonRequest(
              config.baseUrl,
              route,
              participant.token,
              'GET',
              AbortSignal.any([lifetime, AbortSignal.timeout(config.timeoutMs)]),
              transport,
            );
            status = result.status;
            if (status === 200) {
              await parsePublic(type, result.value);
              if (
                operation === 'session' &&
                (result.value.id !== participant.sessionId || result.value.status !== 'ready')
              )
                throw new Error('Session is not the assigned ready attempt.');
              passed = true;
            }
          } catch {}
          measurements.push({
            worker: worker + 1,
            round,
            operation,
            passed,
            status,
            durationMs: performance.now() - at,
          });
          if (!passed) {
            readsPassed = false;
            break;
          }
        }
        if (!readsPassed) break;
        const at = performance.now();
        let status: number | null = null,
          passed = false;
        try {
          const signal = AbortSignal.any([lifetime, AbortSignal.timeout(config.timeoutMs)]);
          const result = await jsonRequest(
            config.baseUrl,
            '/v1/sessions/' + participant.sessionId + '/terminal-tickets',
            participant.token,
            'POST',
            signal,
            transport,
          );
          status = result.status;
          if (status === 200) {
            const ticket = await parsePublic('TerminalTicket', result.value);
            if (ticket.sessionId !== participant.sessionId) throw new Error('Wrong ticket.');
            probes.push(await probe(ticket.url, config.origin, participant.sessionId, ticket.ticket, signal));
            passed = true;
          }
        } catch {}
        measurements.push({
          worker: worker + 1,
          round,
          operation: 'terminal',
          passed,
          status,
          durationMs: performance.now() - at,
        });
        if (!passed) break;
        if (round < config.rounds) await delay(config.thinkTimeMs, undefined, { signal: lifetime }).catch(() => {});
      }
    }),
  );
  const seconds = (performance.now() - started) / 1000;
  const report = {
    schemaVersion: 1,
    kind: 'existing-session-load',
    revision,
    concurrency: config.concurrency,
    rounds: config.rounds,
    thinkTimeMs: config.thinkTimeMs,
    seconds,
    timedOut: lifetime.aborted,
    requestsPerSecond: measurements.length / seconds,
    operations: Object.fromEntries(
      ['catalog', 'account', 'session', 'terminal'].map((operation) => {
        const values = measurements.filter((m) => m.operation === operation);
        return [
          operation,
          {
            attempts: values.length,
            failures: values.filter((m) => !m.passed).length,
            durationMs: distribution(values.map((m) => m.durationMs)),
          },
        ];
      }),
    ),
    terminalAdmissionMs: distribution(probes.map((p) => p.admissionMs)),
    terminalRoundTripMs: distribution(probes.map((p) => p.roundTripMs)),
    measurements,
    limits: [
      'Existing test sessions only. Does not measure task launch or ready latency.',
      'Connections replace any current terminal owner and send Ctrl-C plus a harmless printf.',
      'No deployment, task start/end, proposal, provider call or automatic retry.',
      'No tokens, session IDs, terminal output or endpoint URLs are saved.',
    ],
  };
  await write(report);
  return (
    !report.timedOut &&
    measurements.length === config.concurrency * config.rounds * 4 &&
    measurements.every((m) => m.passed)
  );
}

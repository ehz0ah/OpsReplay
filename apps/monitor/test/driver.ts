// Local container test driver. This is not the future authenticated monitor endpoint.
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Monitor, MonitorError, NodeTransport, limits, parseConfig } from '../src/index.js';
import { writeJson } from '../src/output.js';

async function readManifest(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limits.manifestBytes) throw new MonitorError('invalid_config');
    const bytes = Buffer.alloc(limits.manifestBytes + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limits.manifestBytes) throw new MonitorError('invalid_config');
    return bytes.subarray(0, bytesRead).toString('utf8');
  } finally { await file.close(); }
}

async function main(): Promise<number> {
  let monitor: Monitor | undefined;
  let timer: NodeJS.Timeout | undefined;
  let requestedStop = false;
  let cursor = 0;
  const transport = new NodeTransport();
  const stop = () => { requestedStop = true; };
  const outputFailed = () => monitor?.fail('output_failed');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.stdout.on('error', outputFailed);
  try {
    const [path, seconds = '180'] = process.argv.slice(2);
    if (!path || !/^[1-9][0-9]{0,3}$/.test(seconds) || Number(seconds) > 1200) throw new MonitorError('invalid_config');
    monitor = new Monitor(parseConfig(await readManifest(path)), transport);
    if (!await monitor.verifyInitialState()) throw new MonitorError('initial_state_failed');
    const startedAt = monitor.start();
    timer = setInterval(() => monitor!.tick(), 25);
    monitor.tick();
    await writeJson(process.stdout, { type: 'monitor_started', at: new Date(startedAt).toISOString() });
    while (!requestedStop && monitor.now() - startedAt < Number(seconds) * 1000 && !monitor.failure) {
      for (const frame of monitor.read(cursor)) {
        await writeJson(process.stdout, frame);
        cursor = frame.sequence;
      }
      await delay(100);
    }
    clearInterval(timer);
    if (monitor.failure) throw new MonitorError(monitor.failure);
    const final = await monitor.seal();
    for (const frame of monitor.read(cursor)) await writeJson(process.stdout, frame);
    await writeJson(process.stdout, { type: 'monitor_sealed', final });
    return 0;
  } catch (error) {
    const code = error instanceof MonitorError ? error.code : 'monitor_failed';
    monitor?.fail(code);
    process.stderr.write(JSON.stringify({ type: 'monitor_error', code }) + '\n');
    return 1;
  } finally {
    clearInterval(timer);
    transport.close();
    await monitor?.drain();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    process.stdout.removeListener('error', outputFailed);
  }
}

void main().then(code => { if (code !== 0) process.exit(code); });

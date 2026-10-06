import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { once } from 'node:events';
import { MonitorControl } from './control.js';
import { parseConfig } from './config.js';
import { Monitor } from './monitor.js';
import { waitForRuntimeStop } from './runtime-lifecycle.js';
import { createControlServer } from './server.js';
import { NodeTransport } from './transport.js';
import { limits, MonitorError } from './types.js';

const port = 9443;

async function readManifest(path: string): Promise<string> {
  if (!path.startsWith('/') || path.length > 500) throw new MonitorError('invalid_config');
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

function credential(name: string, maximumBytes: number): Buffer {
  const value = process.env[name];
  if (!value || value.length > maximumBytes * 2 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new MonitorError('invalid_config');
  }
  const result = Buffer.from(value, 'base64');
  if (result.length === 0 || result.length > maximumBytes || result.toString('base64') !== value) {
    throw new MonitorError('invalid_config');
  }
  return result;
}

async function listen(server: ReturnType<typeof createControlServer>): Promise<void> {
  server.listen(port, '0.0.0.0');
  await once(server, 'listening');
}

function closeServer(server: ReturnType<typeof createControlServer> | undefined): void {
  if (!server) return;
  if (server.listening) server.close();
  server.closeAllConnections();
}

async function main(): Promise<number> {
  const transport = new NodeTransport();
  let control: MonitorControl | undefined;
  let server: ReturnType<typeof createControlServer> | undefined;
  try {
    const [path = '/app/challenge.json'] = process.argv.slice(2);
    const secret = process.env.OPSREPLAY_MONITOR_SECRET;
    if (!secret) throw new MonitorError('invalid_config');
    const monitor = new Monitor(parseConfig(await readManifest(path)), transport);
    control = new MonitorControl(monitor);
    server = createControlServer(control, {
      key: credential('OPSREPLAY_MONITOR_TLS_KEY_B64', 16_384),
      cert: credential('OPSREPLAY_MONITOR_TLS_CERT_B64', 16_384),
      secret,
    });
    await listen(server);
    void control.initialise();
    process.stdout.write(JSON.stringify({ type: 'monitor_control_listening', port }) + '\n');
    await waitForRuntimeStop(server);
    closeServer(server);
    await control.close();
    return 0;
  } catch (error) {
    const code = error instanceof MonitorError ? error.code : 'monitor_failed';
    process.stderr.write(JSON.stringify({ type: 'monitor_error', code }) + '\n');
    closeServer(server);
    await control?.close();
    return 1;
  } finally { transport.close(); }
}

void main().then(code => { if (code !== 0) process.exit(code); });

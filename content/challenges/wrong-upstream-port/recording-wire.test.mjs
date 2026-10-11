import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  isTerminalRecordingPage,
  isTerminalRecordingReady,
} from '../../../packages/contracts/private/terminal-recording.ts';

const imageTag = process.env.OPSREPLAY_CHALLENGE_IMAGE ?? 'opsreplay/challenge-wrong-upstream-port:dev';
const runScript = fileURLToPath(new URL('./run-local.sh', import.meta.url));
function run(args, options = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000, ...options });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
  return result.stdout.trim();
}

const sourceScript = `
import base64,json,socket
s=socket.create_connection(('127.0.0.1',7681),timeout=2)
f=s.makefile('rb')
s.sendall(b'{"type":"attach","version":1,"mode":"recording"}\\n')
ready=json.loads(f.readline(24577))
i=socket.create_connection(('127.0.0.1',7681),timeout=2)
r=i.makefile('rb')
i.sendall(b'{"type":"attach","version":1,"mode":"interactive","generation":1,"columns":91,"rows":37}\\n')
assert json.loads(r.readline())['type']=='ready'
command=b"stty -echo; printf '%s' 'AP93aXJlLXRhaWw=' | base64 -d; exit 7\\n"
i.sendall((json.dumps({'type':'input','generation':1,'data':base64.b64encode(command).decode()})+'\\n').encode())
while json.loads(r.readline())['type']!='exit': pass
s.sendall((json.dumps({'type':'read','source':ready['source'],'after':0})+'\\n').encode())
page=json.loads(f.readline(24577))
print(json.dumps({'ready':ready,'page':page}))
`;

test('actual Python recording wire passes the strict TypeScript source contract', async (t) => {
  const image = run(['image', 'inspect', imageTag, '--format', '{{.Id}}']);
  const name = 'opsreplay-recording-wire-' + randomUUID();
  const launched = spawnSync('sh', [runScript, name, image], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(launched.status, 0, launched.stderr);
  const id = launched.stdout.trim();
  t.after(() => run(['rm', '--force', id]));
  const deadline = Date.now() + 25_000;
  while (true) {
    const probe = spawnSync('docker', ['exec', id, 'opsreplay-check-startup'], { timeout: 5_000 });
    if (probe.status === 0) break;
    assert.ok(Date.now() < deadline, 'Challenge startup timed out');
    await delay(100);
  }
  const actual = JSON.parse(run(['exec', id, 'python3', '-c', sourceScript]));
  assert.ok(isTerminalRecordingReady(actual.ready));
  assert.ok(isTerminalRecordingPage(actual.page, actual.ready.source, 0));
  assert.ok(Buffer.byteLength(JSON.stringify(actual.page)) + 1 <= 24 * 1024);
  assert.equal(actual.page.shellState, 'exited');
  assert.equal(actual.page.loss, null);
  assert.ok(actual.page.events.some((event) => event.type === 'input'));
  assert.equal(actual.page.events.at(-1).type, 'exit');
  const bytes = Buffer.concat(
    actual.page.events.filter((event) => event.type === 'output').map((event) => Buffer.from(event.data, 'base64')),
  );
  assert.ok(bytes.includes(Buffer.from([0, 255])));
});

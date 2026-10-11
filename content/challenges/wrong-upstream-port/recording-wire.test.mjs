import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  isTerminalRecordingPage,
  isTerminalRecordingReady,
} from '../../../packages/contracts/private/terminal-recording.ts';

const imageTag = process.env.OPSREPLAY_CHALLENGE_IMAGE ?? 'opsreplay/challenge-wrong-upstream-port:dev';
const runScript = fileURLToPath(new URL('./run-local.sh', import.meta.url));
const recordingTest = readFileSync(new URL('./recording.test.py', import.meta.url), 'utf8');
function run(args, options = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000, ...options });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
  return result.stdout.trim();
}

const sourceScript = `
import base64,json,os,socket,sys,time
s=socket.create_connection(('127.0.0.1',7681),timeout=2)
f=s.makefile('rb')
s.sendall(b'{"type":"attach","version":1,"mode":"recording"}\\n')
ready=json.loads(f.readline(24577))
def attach(generation):
    i=socket.create_connection(('127.0.0.1',7681),timeout=2)
    r=i.makefile('rb')
    i.sendall((json.dumps({'type':'attach','version':1,'mode':'interactive','generation':generation,'columns':91,'rows':37})+'\\n').encode())
    assert json.loads(r.readline())['type']=='ready'
    return i,r
def send(i,generation,command):
    i.sendall((json.dumps({'type':'input','generation':generation,'data':base64.b64encode(command).decode()})+'\\n').encode())
def read(after):
    s.sendall((json.dumps({'type':'read','source':ready['source'],'after':after})+'\\n').encode())
    return json.loads(f.readline(24577))
i,r=attach(1)
mode=sys.argv[1]
after=0
before=None
if mode=='overflow':
    send(i,1,b"head -c 16000000 /dev/zero; touch /tmp/wire-overflow-done\\n")
    while True:
        frame=json.loads(r.readline())
        assert frame['type']!='error',frame
        if frame['type']=='input_accepted': break
    r.close()
    i.close()
    deadline=time.monotonic()+15
    while not os.path.exists('/tmp/wire-overflow-done'):
        assert time.monotonic()<deadline
        time.sleep(0.1)
    before=read(0)
    assert before['loss']['reason']=='limit_exceeded'
    after=before['latestSequence']
    i,r=attach(2)
    send(i,2,b"printf 'unrecorded-after-loss\\n'; exit 7\\n")
else:
    command=b"stty -echo; printf '%s' 'AP93aXJlLXRhaWw=' | base64 -d; "
    if mode=='quiet': command+=b"sleep 300 & "
    send(i,1,command+b"exit 7\\n")
while json.loads(r.readline())['type']!='exit': pass
pages=[]
while True:
    page=read(after)
    pages.append(page)
    after=page['nextSequence']
    if after==page['latestSequence']: break
    time.sleep(0.11)
time.sleep(0.11)
end=read(after)
print(json.dumps({'ready':ready,'before':before,'after':before['latestSequence'] if before else 0,'pages':pages,'end':end}))
`;

const tailBoundScript = `
import json
namespace={'__name__':'recording_test'}
exec(__import__('sys').stdin.read(),namespace)
journal=namespace['real_pty_tail_bound']()
print(json.dumps(journal.page(journal.source,0)))
`;

test('actual Python recording wire preserves exit after a real PTY tail bound', () => {
  const image = run(['image', 'inspect', imageTag, '--format', '{{.Id}}']);
  const page = JSON.parse(
    run(
      ['run', '--rm', '--network', 'none', '--interactive', '--entrypoint', 'python3', image, '-c', tailBoundScript],
      {
        input: recordingTest,
      },
    ),
  );
  assert.ok(isTerminalRecordingPage(page, page.source, 0));
  assert.equal(page.loss.reason, 'data_gap');
  assert.equal(page.events.at(-1).type, 'exit');
  assert.equal(page.events.at(-1).code, 7);
});

for (const mode of ['exit', 'quiet', 'overflow']) {
  test(`actual Python recording wire passes the strict TypeScript source contract (${mode})`, async (t) => {
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
    const actual = JSON.parse(run(['exec', id, 'python3', '-c', sourceScript, mode]));
    assert.ok(isTerminalRecordingReady(actual.ready));
    if (actual.before) assert.ok(isTerminalRecordingPage(actual.before, actual.ready.source, 0));
    let after = actual.after;
    const events = [];
    for (const page of actual.pages) {
      assert.ok(isTerminalRecordingPage(page, actual.ready.source, after));
      assert.ok(Buffer.byteLength(JSON.stringify(page)) + 1 <= 24 * 1024);
      assert.equal(page.shellState, 'exited');
      after = page.nextSequence;
      events.push(...page.events);
    }
    assert.ok(isTerminalRecordingPage(actual.end, actual.ready.source, after));
    assert.deepEqual(actual.end.events, []);
    assert.equal(events.at(-1).type, 'exit');
    assert.equal(events.at(-1).code, 7);
    assert.equal(events.filter((event) => event.type === 'exit').length, 1);
    if (mode === 'overflow') {
      assert.equal(actual.end.loss.reason, 'limit_exceeded');
      assert.ok(events.at(-1).recordedAt >= actual.end.loss.occurredAt);
      assert.deepEqual(actual.end.loss, actual.before.loss);
      assert.equal(events.length, 1);
      assert.equal(after, actual.after + 1);
    } else {
      assert.equal(actual.end.loss, null);
      assert.ok(events.some((event) => event.type === 'input'));
      const bytes = Buffer.concat(
        events.filter((event) => event.type === 'output').map((event) => Buffer.from(event.data, 'base64')),
      );
      assert.ok(bytes.includes(Buffer.from([0, 255])));
    }
  });
}

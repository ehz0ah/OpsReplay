import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';
import { writeJson } from '../src/output.js';

test('output waits for the write callback and bounds stalled consumers', async () => {
  const lines: string[] = [];
  const sink = new Writable({ write(chunk, _encoding, callback) { lines.push(chunk.toString()); callback(); } });
  await writeJson(sink, { type: 'metrics', value: 1 });
  assert.deepEqual(lines, ['{"type":"metrics","value":1}\n']);
  await assert.rejects(writeJson(sink, 'x'.repeat(65537)), /output_failed/);
  const blocked = new Writable({ write() {} });
  await assert.rejects(writeJson(blocked, { value: 1 }, 20), /output_failed/);
  blocked.destroy();
  sink.destroy();
});

test('a write failure is handled without exposing its error or leaving an unhandled event', async () => {
  const failed = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('private-output-path')); } });
  await assert.rejects(writeJson(failed, { value: 1 }), /^MonitorError: output_failed$/);
  await new Promise(resolve => setImmediate(resolve));
});

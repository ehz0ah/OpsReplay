import { execFileSync } from 'node:child_process';

// Check the actual filesystem and preserved package metadata, not a base-image label.
const check = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const zlib = require('node:zlib');
const directory = '/var/lib/dpkg/status.d';
const records = fs.readdirSync(directory).filter(name => !name.endsWith('.md5sums'))
  .map(name => fs.readFileSync(path.join(directory, name), 'utf8'));
const packages = records.flatMap(record => [...record.matchAll(/^Package: (.+)$/gm)].map(match => match[1]));
assert.ok(packages.includes('libc6'), 'Distribution package metadata must remain available');
const unwanted = /^(util-linux|mount|bsdutils|libblkid1|libmount1|libuuid1|zlib1g|libssl3|perl|perl-base)$/;
assert.deepEqual(packages.filter(name => unwanted.test(name)), [], 'Unused vulnerable packages must be absent');
for (const file of ['/bin/sh', '/bin/bash', '/usr/bin/sh', '/usr/bin/bash',
  '/bin/mount', '/usr/bin/mount', '/usr/bin/nsenter', '/usr/bin/apt-get', '/usr/bin/perl'])
  assert.equal(fs.existsSync(file), false, 'Unexpected runtime utility: ' + file);
assert.equal(process.version, 'v22.23.3');
assert.equal(process.getuid(), 1000);
assert.equal(process.getgid(), 1000);
assert.ok(tls.rootCertificates.length > 0);
assert.ok(fs.existsSync('/etc/ssl/certs/ca-certificates.crt'));
tls.createSecureContext();
const payload = Buffer.from('opsreplay-runtime-compression');
assert.deepEqual(zlib.gunzipSync(zlib.gzipSync(payload)), payload);
console.log(JSON.stringify({ node: process.version, uid: process.getuid(), gid: process.getgid(),
  packages: packages.sort(), nodeZlib: process.versions.zlib }));
`;

export function verifyRuntimeImage(image) {
  return JSON.parse(
    execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges=true',
        '--pids-limit',
        '32',
        '--memory',
        '256m',
        '--entrypoint',
        'node',
        image,
        '-e',
        check,
      ],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
    ),
  );
}

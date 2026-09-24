import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { ContentRepository } from './content.js';
import { SqliteRepository } from './sqlite.js';
import { hash } from './validation.js';

if (process.env.NODE_ENV === 'production')
  throw new Error('Local identity is disabled in production.');

const root = fileURLToPath(new URL('../../../', import.meta.url));
const localDirectory = resolve(root, '.local/runtime');
mkdirSync(localDirectory, { recursive: true, mode: 0o700 });
const secretPath = resolve(localDirectory, 'session.key');
try {
  writeFileSync(secretPath, randomBytes(48).toString('hex'), { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
}
const secret = readFileSync(secretPath, 'utf8');
const databasePath = process.env.OPSREPLAY_DB_PATH
  ? resolve(process.env.OPSREPLAY_DB_PATH)
  : resolve(localDirectory, 'opsreplay.sqlite');
mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
const repository = new SqliteRepository(databasePath);
chmodSync(databasePath, 0o600);
try {
  const definition: unknown = JSON.parse(
    readFileSync(
      resolve(root, 'content/challenges/checkout-connection-leak/scenario.json'),
      'utf8',
    ),
  );
  const content = new ContentRepository([definition], true);
  for (const scenario of content.scenarios)
    repository.pinContent(
      scenario.definition.id,
      scenario.definition.version,
      hash(scenario.definition),
    );
  const accounts = [
    { id: 'local-learner', name: 'Local learner' },
    { id: 'local-teammate', name: 'Local teammate' },
  ];
  for (const account of accounts) repository.setAccess(account.id, true);
  const port = Number(process.env.OPSREPLAY_API_PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Invalid OPSREPLAY_API_PORT');
  const app = await buildApp({
    repository,
    content,
    secret,
    accounts,
    logger: true,
    origins: [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:4173',
      'http://127.0.0.1:4173',
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
    ],
  });
  app.addHook('onClose', () => {
    repository.close();
    return Promise.resolve();
  });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void app.close().catch((error: unknown) => {
      app.log.error(error);
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  await app.listen({ host: '127.0.0.1', port });
} catch (error) {
  repository.close();
  throw error;
}

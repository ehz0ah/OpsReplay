import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// One deployable action. SDK and validation versions are bundled from package-lock.json.
await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: ['apps/api/src/start-session/index.ts'],
  outfile: 'dist/start-session/index.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: true,
  sourcemap: false,
  logLevel: 'info',
});

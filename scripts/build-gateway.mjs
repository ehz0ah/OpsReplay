import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
await rm(fileURLToPath(new URL('../dist/gateway/', import.meta.url)), { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: {
    client: 'apps/gateway/src/index.ts',
    runtime: 'apps/gateway/src/gateway-main.ts',
  },
  outdir: 'dist/gateway',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: true,
  sourcemap: false,
  logLevel: 'info',
});

import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
await rm(fileURLToPath(new URL('../dist/monitor/', import.meta.url)), { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: {
    core: 'apps/monitor/src/index.ts',
    client: 'apps/monitor/test/control-client.ts',
    runtime: 'apps/monitor/src/runtime.ts',
  },
  outdir: 'dist/monitor',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: true,
  sourcemap: false,
  logLevel: 'info',
});

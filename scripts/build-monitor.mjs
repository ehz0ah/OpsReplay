import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
await build({ absWorkingDir: root,
  entryPoints: { core: 'apps/monitor/src/index.ts', driver: 'apps/monitor/test/driver.ts' },
  outdir: 'dist/monitor', outExtension: { '.js': '.cjs' },
  bundle: true, platform: 'node', target: 'node22', format: 'cjs',
  minify: true, sourcemap: false, logLevel: 'info',
});

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
await build({ absWorkingDir: root,
  entryPoints: {
    core: 'apps/monitor/src/index.ts',
    client: 'apps/monitor/test/control-client.ts',
    driver: 'apps/monitor/test/driver.ts',
    runtime: 'apps/monitor/src/runtime.ts',
  },
  outdir: 'dist/monitor', outExtension: { '.js': '.cjs' },
  bundle: true, platform: 'node', target: 'node22', format: 'cjs',
  minify: true, sourcemap: false, logLevel: 'info',
});

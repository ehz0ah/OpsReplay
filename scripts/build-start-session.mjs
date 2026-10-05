import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Each entry point becomes one deployable action with its own bundle.
const root = fileURLToPath(new URL('..', import.meta.url));
for (const [entryPoint, outfile] of [
  ['apps/api/src/start-session/index.ts', 'dist/start-session/index.cjs'],
  ['apps/api/src/expire-provisioning/index.ts', 'dist/expire-provisioning/index.cjs'],
]) {
  await build({
    absWorkingDir: root,
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    minify: true,
    sourcemap: false,
    logLevel: 'info',
  });
}

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Each entry point becomes one deployable action with its own bundle.
const root = fileURLToPath(new URL('..', import.meta.url));
for (const [entryPoint, outfile] of [
  ['apps/api/src/get-review/index.ts', 'dist/get-review/index.cjs'],
  ['apps/api/src/submit-review/index.ts', 'dist/submit-review/index.cjs'],
  ['apps/api/src/get-learn/index.ts', 'dist/get-learn/index.cjs'],
  ['apps/api/src/list-catalog/index.ts', 'dist/list-catalog/index.cjs'],
  ['apps/api/src/get-account/index.ts', 'dist/get-account/index.cjs'],
  ['apps/api/src/start-session/index.ts', 'dist/start-session/index.cjs'],
  ['apps/api/src/get-session/index.ts', 'dist/get-session/index.cjs'],
  ['apps/api/src/get-debrief/index.ts', 'dist/get-debrief/index.cjs'],
  ['apps/api/src/list-timeline/index.ts', 'dist/list-timeline/index.cjs'],
  ['apps/api/src/get-playback/index.ts', 'dist/get-playback/index.cjs'],
  ['apps/api/src/create-terminal-ticket/index.ts', 'dist/create-terminal-ticket/index.cjs'],
  ['apps/api/src/expire-provisioning/index.ts', 'dist/expire-provisioning/index.cjs'],
  ['apps/api/src/publish-recording-work/index.ts', 'dist/publish-recording-work/index.cjs'],
  ['apps/api/src/end-session/index.ts', 'dist/end-session/index.cjs'],
  ['apps/api/src/release-hint/index.ts', 'dist/release-hint/index.cjs'],
  ['apps/api/src/reconcile-session/index.ts', 'dist/reconcile-session/index.cjs'],
  ['apps/api/src/sweep-sessions/index.ts', 'dist/sweep-sessions/index.cjs'],
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

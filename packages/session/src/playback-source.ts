import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.js';
/** Pin the fixed recording, terminal prefix and confirmed cleanup snapshot. */
export function playbackSourceHash(
  recording: unknown,
  terminal: unknown,
  lifecycle: unknown,
  monitorFinal?: unknown,
): string {
  return createHash('sha256')
    .update(canonicalJson({ recording, terminal: terminal ?? null, lifecycle, monitorFinal: monitorFinal ?? null }))
    .digest('hex');
}

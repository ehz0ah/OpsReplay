import { ApiClient, ApiError } from './api.js';
import type { PublicTypes } from '../../../packages/contracts/public-types.js';
export function terminal(status: PublicTypes['SessionStatus']) {
  return status !== 'provisioning' && status !== 'ready';
}
export function retryDelay(error: unknown, failures: number, random = Math.random) {
  const floor = error instanceof ApiError ? (error.detail.retryAfterSeconds ?? 0) * 1000 : 0;
  return Math.max(floor, 250, Math.floor(random() * Math.min(30000, 1000 * 2 ** Math.min(failures, 5))));
}
export function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
export async function observeSession(
  api: ApiClient,
  id: string,
  signal: AbortSignal,
  observe: (value: PublicTypes['SessionView'] | null, error: Error | null) => void,
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void> = pause,
) {
  let failures = 0;
  while (!signal.aborted) {
    let delay = 5000;
    try {
      const view = await api.read('SessionView', '/v1/sessions/' + id, signal);
      if (signal.aborted) return;
      if (view.id !== id) throw new Error('The session response does not match this attempt.');
      observe(view, null);
      failures = 0;
      if (terminal(view.status) && (view.debriefAvailable || view.readyAt === null)) return;
      delay = view.status === 'provisioning' ? 2500 : 5000;
    } catch (value) {
      if (signal.aborted) return;
      const error = value instanceof Error ? value : new Error('Session status is unavailable.');
      observe(null, error);
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) return;
      delay = retryDelay(error, ++failures);
    }
    try {
      await wait(delay, signal);
    } catch {
      return;
    }
  }
}
export function timeRemaining(view: PublicTypes['SessionView'], now: number) {
  return view.endsAt === null ? null : Math.max(0, Math.ceil((Date.parse(view.endsAt) - now) / 1000));
}

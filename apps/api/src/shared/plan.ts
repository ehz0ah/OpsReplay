import type { Plan } from '../start-session/types.js';

/** Current access for new operations. Existing attempts keep their saved grant. */
export function effectivePlan(value: Plan | undefined, now: number) {
  if (!Number.isFinite(now)) throw new Error('Invalid plan clock');
  const current = value?.plan === 'pro' && (value.expiresAt === null || Date.parse(value.expiresAt) > now);
  return current
    ? { plan: 'pro' as const, planSource: 'grant' as const, planExpiresAt: value.expiresAt }
    : { plan: 'free' as const, planSource: 'default' as const, planExpiresAt: null };
}

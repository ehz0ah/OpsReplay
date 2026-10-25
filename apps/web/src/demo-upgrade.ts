import type { PublicTypes } from '../../../packages/contracts/public-types.js';
import type { ApiClient } from './api.js';
import { MutationJournal, type PendingMutation } from './mutation-journal.js';

export const demoUpgradePath = '/v1/demo-upgrade';

export async function activateDemoUpgrade(
  api: ApiClient,
  journal: MutationJournal,
): Promise<PublicTypes['DemoUpgradeResult']> {
  const request: PendingMutation = journal.begin({
    kind: 'upgrade',
    path: demoUpgradePath,
    body: { requestId: crypto.randomUUID() },
  });
  try {
    const result = await api.mutate('DemoUpgradeResult', demoUpgradePath, request.body);
    journal.complete(request);
    return result;
  } catch (error) {
    // Only a correlated, definite rejection can remove an uncertain receipt.
    journal.reject(request, error);
    throw error;
  }
}

export function demoUpgradeAvailable(account: PublicTypes['Account']): boolean {
  return account.plan === 'free' && typeof account.demoUpgradeExpiresAt === 'string';
}

export function accessDeadline(value: string | null | undefined): string {
  if (!value) return 'No scheduled expiry';
  return (
    new Intl.DateTimeFormat('en-SG', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Singapore',
    }).format(new Date(value)) + ' SGT'
  );
}

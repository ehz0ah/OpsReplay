import { validOwner } from '../start-session/validation.js';

export interface DemoUpgradePolicy {
  expiresAt: string;
  owners: ReadonlySet<string>;
}

/** An operator enables one fixed presentation window. Clients cannot extend it. */
export function loadDemoUpgradePolicy(env: NodeJS.ProcessEnv): DemoUpgradePolicy | undefined {
  if (env.DEMO_UPGRADE_ENABLED === undefined || env.DEMO_UPGRADE_ENABLED === 'false') return undefined;
  if (env.DEMO_UPGRADE_ENABLED !== 'true') throw new Error('Invalid demo upgrade switch.');
  const expiresAt = env.DEMO_UPGRADE_EXPIRES_AT;
  const owners = env.DEMO_UPGRADE_OWNERS?.split(',');
  if (
    !expiresAt ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    new Date(expiresAt).toISOString() !== expiresAt ||
    !owners ||
    owners.length < 1 ||
    owners.length > 20 ||
    owners.some((owner) => !validOwner(owner)) ||
    new Set(owners).size !== owners.length
  )
    throw new Error('Demo upgrade requires a fixed UTC expiry and an exact learner allowlist.');
  return { expiresAt, owners: new Set(owners) };
}

export function demoUpgradeDeadline(policy: DemoUpgradePolicy | undefined, owner: string, now: number) {
  if (!Number.isFinite(now)) throw new Error('Invalid demo clock.');
  return policy?.owners.has(owner) && Date.parse(policy.expiresAt) > now ? policy.expiresAt : null;
}

/** A broken optional demo setting must not disable normal account reads. */
export function demoPolicyFromEnvironment(env: NodeJS.ProcessEnv, log: (value: object) => void = () => {}) {
  try {
    return loadDemoUpgradePolicy(env);
  } catch {
    try {
      log({ operation: 'load_demo_upgrade', result: 'INVALID_CONFIG' });
    } catch {
      /* Configuration remains disabled. */
    }
    return undefined;
  }
}

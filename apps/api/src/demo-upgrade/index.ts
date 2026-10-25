import { client, table } from '../bootstrap/runtime.js';
import { loadPublicApiPolicy, withPublicApiPolicy } from '../shared/public-api.js';
import { createDemoUpgradeHandler } from './handler.js';
import { demoPolicyFromEnvironment } from './policy.js';
import { DemoUpgradeStore } from './store.js';

export const handler = withPublicApiPolicy(
  createDemoUpgradeHandler(
    new DemoUpgradeStore(client, table!),
    demoPolicyFromEnvironment(process.env, (value) => console.error(JSON.stringify(value))),
    Date.now,
    (value) => console.info(JSON.stringify(value)),
  ),
  loadPublicApiPolicy(process.env),
);

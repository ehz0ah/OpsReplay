import { client, table } from '../bootstrap/runtime.js';
import { loadPublicApiPolicy, withPublicApiPolicy } from '../shared/public-api.js';
import { createGetAccountHandler } from './handler.js';
import { demoPolicyFromEnvironment } from '../demo-upgrade/policy.js';
export const handler = withPublicApiPolicy(
  createGetAccountHandler(
    client,
    table!,
    Date.now,
    (value) => console.info(JSON.stringify(value)),
    demoPolicyFromEnvironment(process.env, (value) => console.error(JSON.stringify(value))),
    process.env.SESSION_ADMISSION_ENABLED === 'true',
  ),
  loadPublicApiPolicy(process.env),
);

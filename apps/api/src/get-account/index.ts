import { client, table } from '../bootstrap/runtime.js';
import { loadPublicApiPolicy, withPublicApiPolicy } from '../shared/public-api.js';
import { createGetAccountHandler } from './handler.js';
export const handler = withPublicApiPolicy(
  createGetAccountHandler(client, table!, Date.now, (value) => console.info(JSON.stringify(value))),
  loadPublicApiPolicy(process.env),
);

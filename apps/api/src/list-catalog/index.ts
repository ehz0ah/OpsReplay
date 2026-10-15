import { client, table } from '../bootstrap/runtime.js';
import { loadPublicApiPolicy, withPublicApiPolicy } from '../shared/public-api.js';
import { createListCatalogHandler } from './handler.js';
export const handler = withPublicApiPolicy(
  createListCatalogHandler(client, table!, (value) => console.info(JSON.stringify(value))),
  loadPublicApiPolicy(process.env),
);

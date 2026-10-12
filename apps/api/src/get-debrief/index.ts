import { createResultStore } from '../result-reads/runtime.js';
import { loadPublicApiPolicy, withPublicApiPolicy } from '../shared/public-api.js';
import { createGetDebriefHandler } from './handler.js';
export const handler = withPublicApiPolicy(
  createGetDebriefHandler(createResultStore(), (entry) => console.info(JSON.stringify(entry))),
  loadPublicApiPolicy(process.env),
);

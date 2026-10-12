import { createResultStore } from '../result-reads/runtime.js';
import { createGetDebriefHandler } from './handler.js';
export const handler = createGetDebriefHandler(createResultStore(), (entry) => console.info(JSON.stringify(entry)));

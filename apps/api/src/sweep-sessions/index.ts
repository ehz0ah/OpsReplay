import { createLifecycleRuntime } from '../session-lifecycle/runtime.js';
import { createSessionSweep } from './handler.js';
const runtime = createLifecycleRuntime();
export const handler = createSessionSweep({
  client: runtime.dynamo,
  table: runtime.table,
  reconcile: runtime.reconcile,
  report: (entry) => console.info(JSON.stringify(entry)),
});

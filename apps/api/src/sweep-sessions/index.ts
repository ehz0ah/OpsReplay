import { sweepAssistantTurns } from '../assistant/sweep.js';
import { createLifecycleRuntime } from '../session-lifecycle/runtime.js';
import { createSessionSweep } from './handler.js';
const runtime = createLifecycleRuntime();
const sweep = createSessionSweep({
  client: runtime.dynamo,
  table: runtime.table,
  reconcile: runtime.reconcile,
  report: (entry) => console.info(JSON.stringify(entry)),
});

export const handler: typeof sweep = async (event, context) => {
  await sweep(event, context);
  const available = context.getRemainingTimeInMillis() - 1000;
  if (available > 1000)
    await sweepAssistantTurns(runtime.dynamo, runtime.table, AbortSignal.timeout(Math.min(available, 10000)));
};

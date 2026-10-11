import { createLifecycleRuntime } from '../session-lifecycle/runtime.js';
import { createReconcileHandler } from './handler.js';
const runtime = createLifecycleRuntime();
export const handler = createReconcileHandler({
  reconcile: runtime.reconcile,
  taskSession: async (id, cluster, task, signal) => {
    const session = await runtime.sessions.session(id, signal);
    return session?.launchArguments.cluster === cluster && session.taskArn === task;
  },
  log: (entry) => console.info(JSON.stringify(entry)),
});

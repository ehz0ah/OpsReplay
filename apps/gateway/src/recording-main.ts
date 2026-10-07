import { loadGatewayRecordingRuntimeConfiguration, runGatewayRecordingRuntime } from './recording-runtime.js';

function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z0-9_.-]{1,128}$/.test(error.name) ? error.name : 'Error';
}

async function main(): Promise<void> {
  const lifetime = new AbortController();
  const stop = (signal: NodeJS.Signals) => {
    console.info(JSON.stringify({ component: 'gateway_recording', type: 'shutdown_requested', signal }));
    lifetime.abort(new Error(signal));
  };
  const term = () => stop('SIGTERM');
  const interrupt = () => stop('SIGINT');
  process.once('SIGTERM', term);
  process.once('SIGINT', interrupt);
  try {
    await runGatewayRecordingRuntime(loadGatewayRecordingRuntimeConfiguration(process.env), lifetime.signal);
  } finally {
    process.removeListener('SIGTERM', term);
    process.removeListener('SIGINT', interrupt);
  }
}

void main().catch((error: unknown) => {
  console.error(
    JSON.stringify({ component: 'gateway_recording', type: 'service_failed', error: { name: errorName(error) } }),
  );
  process.exitCode = 1;
});

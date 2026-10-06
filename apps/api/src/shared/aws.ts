import { NodeHttpHandler } from '@smithy/node-http-handler';

export function createAwsTransport(requestTimeout = 3000) {
  return new NodeHttpHandler({ connectionTimeout: 500, requestTimeout, throwOnRequestTimeout: true });
}

export function sendOptions(abortSignal?: AbortSignal) {
  return abortSignal ? { abortSignal } : {};
}

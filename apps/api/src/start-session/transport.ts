import { NodeHttpHandler } from '@smithy/node-http-handler';

export function createDynamoTransport() {
  return new NodeHttpHandler({
    connectionTimeout: 500,
    requestTimeout: 2000,
    throwOnRequestTimeout: true,
  });
}

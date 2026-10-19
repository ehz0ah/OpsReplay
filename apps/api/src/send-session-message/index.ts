import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import type { Writable } from 'node:stream';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { client, table } from '../bootstrap/runtime.js';
import { createAwsTransport } from '../shared/aws.js';
import { loadPublicApiPolicy } from '../shared/public-api.js';
import { AssistantStore } from '../assistant/store.js';
import { ChatProvider } from '../assistant/provider.js';
import { createAssistantHandler } from '../assistant/handler.js';
import { streamingHandler } from '../assistant/stream-response.js';
declare const awslambda: {
  streamifyResponse: (
    fn: (event: APIGatewayProxyEvent, response: Writable, context: Context) => Promise<void>,
  ) => unknown;
};
const policy = loadPublicApiPolicy(process.env);
const secrets = new SecretsManagerClient({ maxAttempts: 2, requestHandler: createAwsTransport(2000) });
let secret: Promise<string> | undefined;
const endpoint = process.env.ASSISTANT_ENDPOINT,
  model = process.env.ASSISTANT_MODEL,
  arn = process.env.ASSISTANT_SECRET_ARN;
const provider =
  endpoint && model && arn
    ? new ChatProvider({
        endpoint,
        model,
        key: () => {
          secret ??= secrets
            .send(new GetSecretValueCommand({ SecretId: arn }), { abortSignal: AbortSignal.timeout(5000) })
            .then((value) => {
              if (!value.SecretString) throw new Error('Assistant credential missing.');
              return value.SecretString;
            })
            .catch((error) => {
              secret = undefined;
              throw error;
            });
          return secret;
        },
      })
    : null;
const run = createAssistantHandler(new AssistantStore(client, table!), provider, (value) =>
  console.info(JSON.stringify(value)),
);
export const handler = awslambda.streamifyResponse(streamingHandler(run, policy));

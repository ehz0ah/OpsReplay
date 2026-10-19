import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import type { Writable } from 'node:stream';
import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import type { AssistantResponse } from './handler.js';
/** Lambda proxy metadata must precede the eight-byte streaming delimiter. */
export function streamingHandler(
  run: (
    event: APIGatewayProxyEvent,
    context: Context,
    emit: (event: PublicTypes['StreamEvent']) => void,
  ) => Promise<AssistantResponse>,
  policy: { allowedOrigin: string; clientId: string },
) {
  return async (event: APIGatewayProxyEvent, response: Writable, context: Context) => {
    let started = false,
      bytes = 0,
      disconnected = response.destroyed;
    const onError = () => {
      disconnected = true;
    };
    response.on('error', onError);
    const write = (value: string | Buffer) => {
      if (disconnected || response.destroyed) return;
      bytes += Buffer.byteLength(value);
      if (bytes > 512 * 1024) {
        disconnected = true;
        response.destroy();
        return;
      }
      response.write(value);
    };
    const open = (statusCode: number, contentType: string) => {
      started = true;
      write(
        JSON.stringify({
          statusCode,
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': policy.allowedOrigin,
            Vary: 'Origin',
          },
        }),
      );
      write(Buffer.alloc(8));
    };
    const claims = event.requestContext?.authorizer?.claims;
    if (claims?.token_use !== 'id' || claims.aud !== policy.clientId)
      event = {
        ...event,
        requestContext: {
          ...event.requestContext,
          authorizer: { ...event.requestContext.authorizer, claims: { ...claims, sub: undefined } },
        },
      };
    const result = await run(event, context, (value) => {
      if (!started) open(200, 'text/event-stream');
      write('event: ' + value.type + '\ndata: ' + JSON.stringify(value) + '\n\n');
    });
    if (!started) {
      open(result.statusCode, result.statusCode === 200 ? 'text/event-stream' : 'application/json');
      if (result.body !== null) write(JSON.stringify(result.body));
    }
    if (!response.destroyed) response.end();
    // Keep the error listener installed until the runtime finishes the stream.
  };
}

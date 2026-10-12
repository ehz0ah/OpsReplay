import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const host =
  '(?:localhost|[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)';
const port = '(?::(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?';
const originPattern = new RegExp(`^(?:https://${host}${port}|http://localhost${port})$`);
const clientIdPattern = /^[A-Za-z0-9]{1,128}$/;

export interface PublicApiPolicy {
  allowedOrigin: string;
  clientId: string;
}

export function loadPublicApiPolicy(env: NodeJS.ProcessEnv): PublicApiPolicy {
  const allowedOrigin = env.PUBLIC_API_ALLOWED_ORIGIN;
  const clientId = env.COGNITO_USER_POOL_CLIENT_ID;
  if (!allowedOrigin || allowedOrigin.length > 300 || !originPattern.test(allowedOrigin)) {
    throw new Error('PUBLIC_API_ALLOWED_ORIGIN is required and must be one exact approved origin.');
  }
  if (!clientId || !clientIdPattern.test(clientId)) {
    throw new Error('COGNITO_USER_POOL_CLIENT_ID is required and invalid.');
  }
  return { allowedOrigin, clientId };
}

function withoutUnapprovedSubject(event: APIGatewayProxyEvent, clientId: string): APIGatewayProxyEvent {
  const authorizer = event.requestContext?.authorizer;
  const claims = authorizer?.claims;
  if (claims?.token_use === 'id' && claims.aud === clientId) return event;
  return {
    ...event,
    requestContext: {
      ...event.requestContext,
      authorizer: {
        ...authorizer,
        claims: { ...claims, sub: undefined },
      },
    },
  };
}

/** Adds the fixed browser policy and narrows API Gateway's verified pool token to one public app client. */
export function withPublicApiPolicy<TContext>(
  handler: (event: APIGatewayProxyEvent, context: TContext) => Promise<APIGatewayProxyResult>,
  policy: PublicApiPolicy,
) {
  return async (event: APIGatewayProxyEvent, context: TContext): Promise<APIGatewayProxyResult> => {
    const result = await handler(withoutUnapprovedSubject(event, policy.clientId), context);
    return {
      ...result,
      headers: {
        ...result.headers,
        'Access-Control-Allow-Origin': policy.allowedOrigin,
        Vary: 'Origin',
      },
    };
  };
}

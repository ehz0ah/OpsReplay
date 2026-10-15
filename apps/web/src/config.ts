export interface WebConfig {
  apiBaseUrl: string;
  cognitoAuthority: string;
  cognitoClientId: string;
  cognitoLoginUrl: string;
  callbackUrl: string;
  logoutUrl: string;
}
function secureUrl(value: unknown, local: boolean) {
  if (typeof value !== 'string' || value.length > 1024) throw new Error('Invalid public application configuration.');
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(url.protocol === 'https:' || (local && url.protocol === 'http:' && url.hostname === 'localhost'))
  )
    throw new Error('Invalid public application URL.');
  return url;
}
export function parseConfig(value: unknown, origin: string): WebConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Public application configuration is missing.');
  const v = value as Record<string, unknown>;
  const names = ['apiBaseUrl', 'cognitoAuthority', 'cognitoClientId', 'cognitoLoginUrl', 'callbackUrl', 'logoutUrl'];
  if (Object.keys(v).length !== names.length || names.some((n) => !(n in v)))
    throw new Error('Invalid public configuration fields.');
  const local = new URL(origin).hostname === 'localhost';
  const api = secureUrl(v.apiBaseUrl, local);
  const authority = secureUrl(v.cognitoAuthority, false);
  const login = secureUrl(v.cognitoLoginUrl, false);
  const callback = secureUrl(v.callbackUrl, local),
    logout = secureUrl(v.logoutUrl, local);
  if (
    callback.origin !== origin ||
    logout.origin !== origin ||
    !/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/.test(authority.href) ||
    !/^https:\/\/[a-z0-9-]+\.auth\.[a-z0-9-]+\.amazoncognito\.com\/?$/.test(login.href) ||
    typeof v.cognitoClientId !== 'string' ||
    !/^[A-Za-z0-9]{1,128}$/.test(v.cognitoClientId)
  )
    throw new Error('The configured identity or browser origin is invalid.');
  return {
    apiBaseUrl: api.href.replace(/\/$/, ''),
    cognitoAuthority: authority.href,
    cognitoClientId: v.cognitoClientId,
    cognitoLoginUrl: login.href.replace(/\/$/, ''),
    callbackUrl: callback.href,
    logoutUrl: logout.href,
  };
}
export async function loadConfig(): Promise<WebConfig> {
  const response = await fetch('/config.json', {
    cache: 'no-store',
    credentials: 'omit',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Application configuration could not be loaded.');
  return parseConfig(await response.json(), location.origin);
}

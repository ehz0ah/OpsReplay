import type { PublicTypes } from '@opsreplay/contracts';
import { validatePublic } from '@opsreplay/contracts/validation';

export class RequestError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly code = 'NETWORK_ERROR',
  ) {
    super(message);
  }
}

export async function request(path: string, body?: unknown, ownerId?: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'X-OpsReplay-Client': 'web',
        ...(ownerId ? { 'X-OpsReplay-Owner': ownerId } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new RequestError('Cannot reach OpsReplay. Check the connection and try again.');
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new RequestError('The server returned an unreadable response.', response.status);
  }
  if (!response.ok) {
    const error = validatePublic('Error', data);
    throw new RequestError(
      error.ok ? error.value.message : 'The request could not be completed.',
      response.status,
      error.ok ? error.value.code : 'INVALID_RESPONSE',
    );
  }
  return data;
}

export async function read<K extends keyof PublicTypes>(
  name: K,
  path: string,
  body?: unknown,
  ownerId?: string,
): Promise<PublicTypes[K]> {
  const result = validatePublic(name, await request(path, body, ownerId));
  if (!result.ok)
    throw new RequestError('The server response does not match the application contract.');
  return result.value;
}

export interface Account {
  id: string;
  name: string;
}
function account(value: unknown): Account {
  if (
    !value ||
    typeof value !== 'object' ||
    !('id' in value) ||
    !('name' in value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string'
  )
    throw new RequestError('Invalid local account response.');
  return { id: value.id, name: value.name };
}
export async function currentAccount(): Promise<Account | null> {
  try {
    const data = await request('/dev/me');
    if (!data || typeof data !== 'object' || !('account' in data))
      throw new RequestError('Invalid account response.');
    return account(data.account);
  } catch (error) {
    if (error instanceof RequestError && error.code === 'UNAUTHENTICATED') return null;
    throw error;
  }
}
export async function localAccounts(): Promise<Account[]> {
  const data = await request('/dev/accounts');
  if (!data || typeof data !== 'object' || !('accounts' in data) || !Array.isArray(data.accounts))
    throw new RequestError('Invalid account list.');
  return data.accounts.map(account);
}
export const sessionPath = (id: string) => '/v1/sessions/' + encodeURIComponent(id);

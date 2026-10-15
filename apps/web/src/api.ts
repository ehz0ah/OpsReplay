import { parsePublic, type BrowserType } from '../../../packages/contracts/public-validation.js';
import type { PublicTypes } from '../../../packages/contracts/public-types.js';
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: PublicTypes['Error'],
  ) {
    super(detail.message);
  }
}
export class TransportError extends Error {
  constructor() {
    super('The response is uncertain. Retry the same request or read current state.');
  }
}
export class ApiClient {
  constructor(
    readonly baseUrl: string,
    readonly token: () => Promise<string | null>,
    private readonly transport: typeof fetch = (...args) => fetch(...args),
  ) {}
  async read<K extends BrowserType>(type: K, path: string, signal?: AbortSignal): Promise<PublicTypes[K]> {
    return this.request(type, path, undefined, signal);
  }
  async mutate<K extends BrowserType>(
    type: K,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<PublicTypes[K]> {
    return this.request(type, path, body, signal);
  }
  private async request<K extends BrowserType>(
    type: K,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<PublicTypes[K]> {
    if (!path.startsWith('/v1/') || path.startsWith('//') || path.includes('#')) throw new Error('Invalid API path.');
    const token = path.split('?')[0] === '/v1/catalog' ? null : await this.token();
    if (path.split('?')[0] !== '/v1/catalog' && !token) throw new Error('Sign in to continue.');
    const timeout = AbortSignal.timeout(25000);
    let response: Response;
    try {
      response = await this.transport(this.baseUrl + path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      throw new TransportError();
    }
    let value: unknown;
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty response');
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let text = '',
        bytes = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 4 * 1024 * 1024) {
            await reader.cancel();
            throw new Error('Response exceeds its bound');
          }
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      value = JSON.parse(text);
    } catch {
      throw new TransportError();
    }
    if (!response.ok) throw new ApiError(response.status, await parsePublic('Error', value));
    return parsePublic(type, value);
  }
}

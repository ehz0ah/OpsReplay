import { parseMutation, parsePublic } from '../../../../packages/contracts/public-validation.js';
import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import { ApiError, TransportError } from '../api.js';
export async function streamAssistant(
  baseUrl: string,
  token: string,
  id: string,
  request: PublicTypes['MessageRequest'],
  observe: (value: PublicTypes['StreamEvent']) => void,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
) {
  parseMutation('MessageRequest', request);
  let response: Response;
  try {
    response = await transport(baseUrl + '/v1/sessions/' + id + '/messages', {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(request),
      signal: AbortSignal.any([signal, AbortSignal.timeout(70000)]),
    });
  } catch {
    throw new TransportError();
  }
  if (!response.ok) {
    let error: unknown;
    try {
      error = await response.json();
    } catch {
      throw new TransportError();
    }
    throw new ApiError(response.status, await parsePublic('Error', error));
  }
  if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body)
    throw new TransportError();
  const reader = response.body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '',
    bytes = 0,
    sequence = -1,
    terminal = false,
    textLength = 0;
  async function block(text: string) {
    const data = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    const event = await parsePublic('StreamEvent', JSON.parse(data));
    if (
      terminal ||
      event.turnId !== request.requestId ||
      event.sequence !== sequence + 1 ||
      (sequence === -1 && event.type !== 'turn_started')
    )
      throw new Error('Invalid assistant stream sequence.');
    if (event.type === 'turn_started' && (sequence !== -1 || event.data.requestId !== request.requestId))
      throw new TransportError();
    if (event.type === 'turn_completed' && event.data.id !== request.requestId) throw new TransportError();
    if (event.type === 'text_delta') {
      textLength += event.data.text.length;
      if (textLength > 20000) throw new TransportError();
    }
    terminal = event.type === 'turn_completed' || event.type === 'turn_failed';
    sequence = event.sequence;
    observe(event);
  }
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 512 * 1024) throw new Error('Assistant stream exceeds its bound.');
      pending += decoder.decode(part.value, { stream: true });
      pending = pending.replace(/\r\n/g, '\n');
      let at;
      while ((at = pending.indexOf('\n\n')) >= 0) {
        await block(pending.slice(0, at));
        pending = pending.slice(at + 2);
      }
    }
    pending += decoder.decode();
    if (pending.trim()) throw new TransportError();
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

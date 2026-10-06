import http from 'node:http';
import net from 'node:net';
import { endpoint, validHost } from './config.js';
import { limits } from './types.js';
import type { HttpCheck, HttpResponse, Transport } from './types.js';

export class NodeTransport implements Transport {
  private readonly agent = new http.Agent({ keepAlive: true, maxSockets: limits.inFlight,
    maxTotalSockets: limits.inFlight, maxFreeSockets: 4, timeout: 5_000 });

  async http(check: HttpCheck, signal: AbortSignal, json?: object): Promise<HttpResponse | null> {
    const url = endpoint(check.url);
    if (signal.aborted) return null;
    const body = json === undefined ? undefined : Buffer.from(JSON.stringify(json));
    if (body && body.length > 4096) return null;
    return new Promise(resolve => {
      let finished = false;
      let response: http.IncomingMessage | undefined;
      const finish = (result: HttpResponse | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        resolve(result);
        if (result === null) {
          response?.destroy();
          request.destroy();
        }
      };
      const request = http.request(url, {
        method: check.method, agent: this.agent, maxHeaderSize: 8192,
        headers: body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {},
      });
      const abort = () => finish(null);
      // Absolute timeout includes waiting for a socket and slowly streamed bodies.
      const timer = setTimeout(abort, check.timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      request.on('error', abort);
      request.on('response', incoming => {
        response = incoming;
        const status = incoming.statusCode ?? 0;
        if (status >= 300 && status < 400) { finish(null); return; }
        let bytes = 0;
        // A fixed buffer also bounds overhead if a peer sends one-byte chunks.
        const buffer = Buffer.allocUnsafe(limits.bodyBytes);
        incoming.on('error', abort);
        incoming.on('aborted', abort);
        incoming.on('data', (chunk: Buffer) => {
          if (bytes + chunk.length > limits.bodyBytes) finish(null);
          else { chunk.copy(buffer, bytes); bytes += chunk.length; }
        });
        incoming.on('end', () => finish({ status, body: buffer.subarray(0, bytes).toString('utf8') }));
      });
      if (signal.aborted) abort();
      else request.end(body);
    });
  }

  async tcp(host: string, port: number, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
    if (!validHost(host) || !Number.isInteger(port) || port < 1 || port > 65535 || signal.aborted) return false;
    return new Promise(resolve => {
      const socket = net.createConnection({ host, port });
      let finished = false;
      const finish = (ok: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        socket.destroy();
        resolve(ok);
      };
      const abort = () => finish(false);
      const timer = setTimeout(abort, timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      socket.once('connect', () => finish(true));
      socket.once('error', abort);
      if (signal.aborted) abort();
    });
  }

  close(): void { this.agent.destroy(); }
}

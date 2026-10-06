import { randomUUID } from 'node:crypto';
import type { HttpCheck, HttpResponse, Journey, Transport, ValidatorCheck } from './types.js';

function order(response: HttpResponse | null, status: number, reference: string): string | null {
  if (!response || response.status !== status) return null;
  try {
    const data: unknown = JSON.parse(response.body);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const value = data as Record<string, unknown>;
    return typeof value.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.id)
      && value.reference === reference && value.status === 'confirmed' ? value.id : null;
  } catch { return null; }
}

export async function journey(check: Journey, transport: Transport, signal: AbortSignal,
  observe?: (step: HttpCheck, run: () => Promise<boolean>) => Promise<boolean>): Promise<boolean> {
  for (const step of check.steps) {
    if (signal.aborted) return false;
    const run = async () => {
      const result = await transport.http(step, signal);
      return result !== null && step.expectStatus.includes(result.status);
    };
    if (!(await (observe ? observe(step, run) : run()))) return false;
  }
  return true;
}

export async function validateCheck(check: ValidatorCheck, journeys: Journey[], transport: Transport,
  signal: AbortSignal): Promise<boolean> {
  if (check.kind === 'journey') {
    const target = journeys.find(j => j.id === check.journey);
    return target ? journey(target, transport, signal) : false;
  }
  const reference = randomUUID();
  const options = { timeoutMs: check.timeoutMs, expectStatus: [201] };
  const id = order(await transport.http({ ...options, method: 'POST',
    url: check.baseUrl + '/api/checkout' }, signal, { reference }), 201, reference);
  if (!id || signal.aborted) return false;
  return order(await transport.http({ ...options, method: 'GET',
    url: check.baseUrl + '/api/orders/' + id }, signal), 200, reference) === id;
}

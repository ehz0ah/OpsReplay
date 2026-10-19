import { parsePublic } from '../../../packages/contracts/public-validation.js';
import type { PublicTypes } from '../../../packages/contracts/public-types.js';
export interface FreeLessonSummary {
  id: string;
  version: string;
  title: string;
  category: string;
  summary: string;
}
async function assetJson(response: Response, maximumBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing lesson data.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0,
    text = '';
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximumBytes) throw new Error('Lesson data exceeds its bound.');
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
export async function readFreeLessonIndex(signal: AbortSignal): Promise<FreeLessonSummary[]> {
  const response = await fetch('/learn/index.json', {
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    credentials: 'omit',
    redirect: 'error',
  });
  if (!response.ok) throw new Error('The free lessons could not be loaded.');
  const values: unknown = await assetJson(response, 256 * 1024);
  if (!Array.isArray(values) || values.length > 100) throw new Error('Invalid lesson index.');
  const ids = new Set();
  for (const value of values) {
    if (
      !value ||
      typeof value !== 'object' ||
      Object.keys(value).length !== 5 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.id) ||
      ids.has(value.id) ||
      !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value.version) ||
      ['title', 'category', 'summary'].some(
        (key) => typeof value[key] !== 'string' || !value[key].length || value[key].length > 2000,
      )
    )
      throw new Error('Invalid lesson index.');
    ids.add(value.id);
  }
  return values as FreeLessonSummary[];
}
export async function readFreeLesson(id: string, signal: AbortSignal): Promise<PublicTypes['LearnEntry'] | null> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 100) throw new Error('Invalid lesson ID.');
  const index = await readFreeLessonIndex(signal);
  if (!index.some((entry) => entry.id === id)) return null;
  const response = await fetch(`/learn/${id}.json`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    credentials: 'omit',
    redirect: 'error',
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('The lesson could not be loaded.');
  const entry = await parsePublic('LearnEntry', await assetJson(response, 256 * 1024));
  if (entry.plan !== 'free' || entry.id !== id) throw new Error('Invalid free lesson.');
  return entry;
}

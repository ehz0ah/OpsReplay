import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import publicSchema from '../../contracts/schemas/public.schema.json';
import type { PublicTypes } from '../../contracts/public-types.js';
import { canonicalJson } from '../../session/src/canonical.js';
import type { CatalogEntry } from './catalogue.js';

export type LearnEntry = PublicTypes['LearnEntry'];
const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addSchema(publicSchema);
export const isLearnEntry = ajv.compile<LearnEntry>({ $ref: `${publicSchema.$id}#/$defs/LearnEntry` });
export const learnMaximumBytes = 256 * 1024;
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
export function sanitiseLessonHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['h2', 'h3', 'h4', 'p', 'a', 'ul', 'ol', 'li', 'strong', 'em', 'code', 'pre', 'blockquote', 'hr'],
    allowedAttributes: { a: ['href', 'title', 'rel'] },
    allowedSchemes: ['https'],
    allowProtocolRelative: false,
    transformTags: { a: (_tag, attrs) => ({ tagName: 'a', attribs: { ...attrs, rel: 'noopener noreferrer' } }) },
  });
}
export function renderLesson(source: string): string {
  if (Buffer.byteLength(source) > 128 * 1024) throw new Error('Lesson source exceeds its bound.');
  return sanitiseLessonHtml(markdown.render(source));
}
/** YAML metadata between explicit front-matter fences; the body is original Markdown. */
export function parseLesson(source: string, related: ReadonlySet<string>): LearnEntry {
  if (Buffer.byteLength(source) > learnMaximumBytes) throw new Error('Lesson source exceeds its bound.');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/.exec(source);
  if (!match) throw new Error('Lesson needs YAML metadata and a Markdown body.');
  const metadata: unknown = parse(match[1]!, { maxAliasCount: 0, uniqueKeys: true });
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || 'html' in metadata)
    throw new Error('Invalid lesson metadata.');
  const entry = { ...metadata, html: renderLesson(match[2]!) };
  if (!isLearnEntry(entry) || Buffer.byteLength(canonicalJson(entry)) > learnMaximumBytes)
    throw new Error('Invalid lesson content.');
  if (entry.sources.some((source) => new URL(source.url).protocol !== 'https:'))
    throw new Error('Lesson sources must use HTTPS.');
  for (const exercise of entry.relatedExercises)
    if (!related.has(`${exercise.mode}#${exercise.id}`)) throw new Error('Unknown related exercise.');
  return entry;
}
export interface LearnRelease {
  schemaVersion: 1;
  entry: Pick<LearnEntry, 'id' | 'version' | 'plan'>;
  objectKey: string;
  sha256: string;
  byteLength: number;
}
export function prepareLesson(entry: LearnEntry) {
  if (
    !isLearnEntry(entry) ||
    sanitiseLessonHtml(entry.html) !== entry.html ||
    entry.sources.some((source) => new URL(source.url).protocol !== 'https:')
  )
    throw new Error('Invalid lesson.');
  const body = canonicalJson(entry);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const release: LearnRelease = {
    schemaVersion: 1,
    entry: { id: entry.id, version: entry.version, plan: entry.plan },
    objectKey: `content/learn/${entry.id}/${entry.version}/${sha256}.json`,
    sha256,
    byteLength: Buffer.byteLength(body),
  };
  const catalogue: CatalogEntry = {
    id: entry.id,
    version: entry.version,
    mode: 'learn',
    title: entry.title,
    summary: entry.summary,
    category: entry.category,
    plan: entry.plan,
  };
  if (release.byteLength > learnMaximumBytes || entry.summary.length > 1000)
    throw new Error('Lesson publication exceeds its bound.');
  return { body, release, catalogue };
}
export function isLearnRelease(v: unknown): v is LearnRelease {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const value = v as LearnRelease;
  return (
    Object.keys(value).length === 5 &&
    value.schemaVersion === 1 &&
    !!value.entry &&
    Object.keys(value.entry).length === 3 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.entry.id) &&
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value.entry.version) &&
    ['free', 'pro'].includes(value.entry.plan) &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    value.objectKey === `content/learn/${value.entry.id}/${value.entry.version}/${value.sha256}.json` &&
    Number.isSafeInteger(value.byteLength) &&
    value.byteLength > 0 &&
    value.byteLength <= learnMaximumBytes
  );
}
export const learnKey = (id: string) => ({ PK: `CONTENT#learn#${id}`, SK: 'PUBLISHED' });

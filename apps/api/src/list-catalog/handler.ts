import { createHash } from 'node:crypto';
import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  cataloguePartition,
  catalogueKey,
  validCatalogEntry,
  validCatalog,
  type CatalogEntry,
} from '../../../../packages/content/src/catalogue.js';
import { bootstrapHandler, BootstrapError } from '../bootstrap/handler.js';
import { canonicalJson } from '../../../../packages/session/src/canonical.js';

const invalid = () => new BootstrapError('INVALID_REQUEST');
const names = ['mode', 'tier', 'category', 'language', 'plan'] as const;
function parameters(event: Parameters<ReturnType<typeof bootstrapHandler>>[0]) {
  const query =
    event.multiValueQueryStringParameters ??
    Object.fromEntries(Object.entries(event.queryStringParameters ?? {}).map(([k, v]) => [k, [v]]));
  if (
    Object.keys(query).some((k) => ![...names, 'limit', 'cursor'].includes(k)) ||
    Object.values(query).some((v) => !v || v.length !== 1 || typeof v[0] !== 'string')
  )
    throw invalid();
  const get = (name: string) => query[name]?.[0];
  const raw = get('limit');
  const limit = raw === undefined ? 50 : Number(raw);
  if ((raw !== undefined && !/^[1-9][0-9]*$/.test(raw)) || !Number.isInteger(limit) || limit > 100 || limit < 1)
    throw invalid();
  const filters: Partial<Record<(typeof names)[number], string>> = {};
  for (const name of names) {
    const value = get(name);
    if (value !== undefined) {
      if (!value.length || value.length > 80) throw invalid();
      filters[name] = value;
    }
  }
  if (
    (filters.mode && !['learn', 'challenge', 'code_review'].includes(filters.mode)) ||
    (filters.tier && !['easy', 'medium', 'hard'].includes(filters.tier)) ||
    (filters.plan && !['free', 'pro'].includes(filters.plan))
  )
    throw invalid();
  const cursor = get('cursor');
  if (cursor !== undefined && (cursor.length < 1 || cursor.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(cursor)))
    throw invalid();
  return { filters, limit, cursor };
}
export function createListCatalogHandler(client: DynamoDBDocumentClient, table: string, log?: (value: object) => void) {
  return bootstrapHandler(
    'list_catalog',
    '/v1/catalog',
    false,
    async (event, _owner, signal) => {
      const { filters, limit, cursor } = parameters(event);
      const entries: CatalogEntry[] = [];
      let after: Record<string, unknown> | undefined;
      let bytes = 0;
      // Bound one small curated MVP catalogue independently of page size. Filtering
      // and filter facets use the same validated dataset, not only the returned page.
      for (let pages = 0; ; pages++) {
        if (pages >= 20) throw new Error('Catalogue query bound exceeded');
        const result = await client.send(
          new QueryCommand({
            TableName: table,
            ConsistentRead: true,
            Limit: 100,
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
            ExpressionAttributeValues: { ':pk': cataloguePartition, ':prefix': 'ENTRY#' },
            ...(after ? { ExclusiveStartKey: after } : {}),
          }),
          { abortSignal: signal },
        );
        for (const row of result.Items ?? []) {
          if (!validCatalogEntry(row.data) || row.PK !== cataloguePartition || row.SK !== catalogueKey(row.data).SK)
            throw new Error('Invalid catalogue projection');
          entries.push(row.data);
          bytes += Buffer.byteLength(canonicalJson(row.data));
          if (entries.length > 1000 || bytes > 2 * 1024 * 1024) throw new Error('Catalogue size bound exceeded');
        }
        const next = result.LastEvaluatedKey;
        if (!next) break;
        if (
          next.PK !== cataloguePartition ||
          typeof next.SK !== 'string' ||
          !next.SK.startsWith('ENTRY#') ||
          (after && next.SK <= String(after.SK))
        )
          throw new Error('Invalid catalogue continuation');
        after = next;
      }
      entries.sort((a, b) =>
        catalogueKey(a).SK < catalogueKey(b).SK ? -1 : catalogueKey(a).SK > catalogueKey(b).SK ? 1 : 0,
      );
      if (new Set(entries.map((e) => catalogueKey(e).SK)).size !== entries.length)
        throw new Error('Duplicate catalogue projection');
      const snapshot = createHash('sha256').update(canonicalJson(entries)).digest('hex');
      const selected = entries.filter((entry) =>
        names.every((name) => filters[name] === undefined || entry[name] === filters[name]),
      );
      let offset = 0;
      if (cursor !== undefined) {
        try {
          const bytes = Buffer.from(cursor, 'base64url');
          if (cursor.length > 1000 || bytes.toString('base64url') !== cursor) throw invalid();
          const value = JSON.parse(bytes.toString());
          if (
            Object.keys(value).length !== 4 ||
            value.v !== 1 ||
            value.snapshot !== snapshot ||
            canonicalJson(value.filters) !== canonicalJson(filters) ||
            !Number.isSafeInteger(value.offset) ||
            value.offset < 1 ||
            value.offset > selected.length
          )
            throw invalid();
          offset = value.offset;
        } catch {
          throw invalid();
        }
      }
      const end = Math.min(offset + limit, selected.length);
      const distinct = <K extends (typeof names)[number]>(key: K) =>
        [...new Set(entries.flatMap((e) => (e[key] === undefined ? [] : [e[key]!])))].sort();
      const value = {
        items: selected.slice(offset, end),
        nextCursor:
          end < selected.length
            ? Buffer.from(JSON.stringify({ v: 1, snapshot, filters, offset: end })).toString('base64url')
            : null,
        availableFilters: {
          modes: distinct('mode'),
          tiers: distinct('tier'),
          categories: distinct('category'),
          languages: distinct('language'),
          plans: distinct('plan'),
        },
      };
      if (!validCatalog(value)) throw new Error('Invalid catalogue response');
      return value;
    },
    log,
  );
}

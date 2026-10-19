import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { S3Client } from '@aws-sdk/client-s3';
import { isLearnEntry, isLearnRelease, learnKey, sanitiseLessonHtml } from '../../../../packages/content/src/learn.js';
import { readRecordingObject } from '../../../../packages/session/src/object-reader.js';
import { validOwner, validPlan } from '../start-session/validation.js';
import { keys } from '../start-session/store.js';
import { effectivePlan } from '../shared/plan.js';
export function createGetLearnHandler(
  client: DynamoDBDocumentClient,
  table: string,
  s3: S3Client,
  bucket: string,
  now = Date.now,
) {
  return async (event: APIGatewayProxyEvent, context: Pick<Context, 'getRemainingTimeInMillis'>) => {
    const requestId = randomUUID();
    const reply = (statusCode: number, body: unknown) => ({
      statusCode,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      body: JSON.stringify(body),
    });
    const fail = (status: number, code: string, message: string) => reply(status, { code, message, requestId });
    try {
      const id = event.pathParameters?.id;
      if (
        event.httpMethod !== 'GET' ||
        event.resource !== '/v1/learn/{id}' ||
        event.body !== null ||
        event.isBase64Encoded ||
        !id ||
        id.length > 100 ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ||
        Object.keys(event.multiValueQueryStringParameters ?? event.queryStringParameters ?? {}).length
      )
        return fail(400, 'INVALID_REQUEST', 'Invalid lesson request.');
      const time = context.getRemainingTimeInMillis() - 1000;
      const signal = time > 0 ? AbortSignal.timeout(time) : AbortSignal.abort();
      signal.throwIfAborted();
      const read = async (Key: object) =>
        (await client.send(new GetCommand({ TableName: table, Key, ConsistentRead: true }), { abortSignal: signal }))
          .Item?.data as unknown;
      const release = await read(learnKey(id));
      if (!release) return fail(404, 'NOT_FOUND', 'Lesson not found.');
      if (!isLearnRelease(release) || release.entry.id !== id) throw new Error('Invalid lesson release.');
      if (release.entry.plan === 'pro') {
        const owner: unknown = event.requestContext?.authorizer?.claims?.sub;
        if (!validOwner(owner)) return fail(401, 'UNAUTHENTICATED', 'Sign in to read this lesson.');
        const plan = await read(keys.plan(owner));
        if (plan !== undefined && !validPlan(plan)) throw new Error('Invalid plan.');
        if (effectivePlan(plan, now()).plan !== 'pro')
          return fail(403, 'PLAN_REQUIRED', 'This lesson requires Pro access.');
      }
      const entry = await readRecordingObject(
        s3,
        bucket,
        release.objectKey,
        release.sha256,
        release.byteLength,
        signal,
      );
      if (
        !isLearnEntry(entry) ||
        entry.id !== id ||
        entry.version !== release.entry.version ||
        entry.plan !== release.entry.plan ||
        sanitiseLessonHtml(entry.html) !== entry.html
      )
        throw new Error('Lesson integrity mismatch.');
      return reply(200, entry);
    } catch {
      return fail(500, 'INTERNAL_ERROR', 'The lesson could not be read. Try again.');
    }
  };
}

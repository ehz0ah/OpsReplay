import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { readRecordingObject } from '../../session/src/object-reader.js';
import { retryDynamoConflict } from '../../dynamodb/src/conflict-retry.js';
import { canonicalJson } from '../../session/src/canonical.js';
import { learnKey, prepareLesson, type LearnEntry } from './learn.js';
import { catalogueKey } from './catalogue.js';
/** Explicit publication only. Store immutable data before making a catalogue entry readable. */
export async function publishLesson(
  client: DynamoDBDocumentClient,
  table: string,
  s3: S3Client,
  bucket: string,
  entry: LearnEntry,
  signal: AbortSignal,
) {
  const { body, release, catalogue } = prepareLesson(entry);
  const key = learnKey(entry.id);
  const prior = (
    await client.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }), { abortSignal: signal })
  ).Item?.data;
  if (prior && canonicalJson(prior) !== canonicalJson(release))
    throw new Error('A different lesson is already published.');
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: release.objectKey,
        Body: body,
        ContentLength: release.byteLength,
        ContentType: 'application/json',
        CacheControl: 'no-store',
        ServerSideEncryption: 'AES256',
        IfNoneMatch: '*',
      }),
      { abortSignal: signal },
    );
  } catch (error) {
    if (!(
      error &&
      typeof error === 'object' &&
      '$metadata' in error &&
      (error.$metadata as { httpStatusCode?: number }).httpStatusCode === 412
    ))
      throw error;
  }
  const stored = await readRecordingObject(s3, bucket, release.objectKey, release.sha256, release.byteLength, signal);
  if (canonicalJson(stored) !== body) throw new Error('Published lesson object does not match.');
  await retryDynamoConflict(
    () =>
      client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: table,
                Item: { ...key, data: release },
                ConditionExpression: 'attribute_not_exists(PK) OR #d = :same',
                ExpressionAttributeNames: { '#d': 'data' },
                ExpressionAttributeValues: { ':same': release },
              },
            },
            {
              Put: {
                TableName: table,
                Item: { ...catalogueKey(catalogue), data: catalogue },
                ConditionExpression: 'attribute_not_exists(PK) OR #d = :same',
                ExpressionAttributeNames: { '#d': 'data' },
                ExpressionAttributeValues: { ':same': catalogue },
              },
            },
          ],
        }),
        { abortSignal: signal },
      ),
    signal,
  );
}

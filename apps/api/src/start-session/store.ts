import { sendOptions } from '../shared/aws.js';
import { randomUUID } from 'node:crypto';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient, TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import type { ValidateFunction } from 'ajv';
import { validContent, validLock, validPlan, validProgress, validReceipt, validSession, validSessionRelations } from './validation.js';
import type { Admission, StartRequest } from './types.js';

export const keys = {
  receipt: (owner: string, request: string) => ({ PK: `USER#${owner}`, SK: `START#${request}` }),
  active: (owner: string) => ({ PK: `USER#${owner}`, SK: 'ACTIVE' }),
  plan: (owner: string) => ({ PK: `USER#${owner}`, SK: 'PLAN' }),
  progress: (owner: string, challenge: string) => ({ PK: `USER#${owner}`, SK: `PROGRESS#${challenge}` }),
  content: (id: string, version: string) => ({ PK: `CONTENT#${id}`, SK: `VERSION#${version}` }),
  session: (id: string) => ({ PK: `SESSION#${id}`, SK: 'STATE' }),
};
type Key = { PK: string; SK: string };

export class StartStore {
  constructor(private readonly client: DynamoDBDocumentClient, private readonly table: string) {}

  private async get<T>(key: Key, validate: ValidateFunction<T>, abortSignal?: AbortSignal): Promise<T | undefined> {
    const command = new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true });
    const result = await this.client.send(command, sendOptions(abortSignal));
    if (!result.Item) return undefined;
    if (!validate(result.Item.data)) throw new Error('Invalid stored admission record');
    return result.Item.data;
  }

  receipt(owner: string, request: string, abortSignal?: AbortSignal) {
    return this.get(keys.receipt(owner, request), validReceipt, abortSignal);
  }
  async session(id: string, abortSignal?: AbortSignal) {
    const session = await this.get(keys.session(id), validSession, abortSignal);
    if (session && !validSessionRelations(session)) throw new Error('Invalid stored session relationships');
    return session;
  }
  active(owner: string, abortSignal?: AbortSignal) { return this.get(keys.active(owner), validLock, abortSignal); }

  async snapshot(owner: string, request: StartRequest, abortSignal?: AbortSignal) {
    const [content, plan, progress] = await Promise.all([
      this.get(keys.content(request.challengeId, request.challengeVersion), validContent, abortSignal),
      this.get(keys.plan(owner), validPlan, abortSignal),
      this.get(keys.progress(owner, request.challengeId), validProgress, abortSignal),
    ]);
    return { content, plan, progress };
  }

  async commit(admission: Admission, abortSignal?: AbortSignal): Promise<void> {
    const { session, receipt, request, snapshot } = admission;
    const owner = session.ownerId;
    const put = (key: Key, data: object) => ({ Put: {
      TableName: this.table, Item: { ...key, data }, ConditionExpression: 'attribute_not_exists(PK)',
    } });
    const unchanged = (key: Key, data: object | undefined) => ({ ConditionCheck: {
      TableName: this.table, Key: key,
      ...(data === undefined ? { ConditionExpression: 'attribute_not_exists(PK)' } : {
        ConditionExpression: '#data = :expected',
        ExpressionAttributeNames: { '#data': 'data' }, ExpressionAttributeValues: { ':expected': data },
      }),
    } });
    const input: TransactWriteCommandInput = {
      // SDK retries reuse this token and the exact transaction. Receipts outlive its window.
      ClientRequestToken: randomUUID(),
      TransactItems: [
        put(keys.receipt(owner, request.requestId), receipt),
        put(keys.active(owner), { sessionId: session.view.id, requestId: request.requestId }),
        put(keys.session(session.view.id), session),
        unchanged(keys.content(request.challengeId, request.challengeVersion), snapshot.content),
        unchanged(keys.plan(owner), snapshot.plan),
        unchanged(keys.progress(owner, request.challengeId), snapshot.progress),
      ],
    };
    const command = new TransactWriteCommand(input);
    await this.client.send(command, sendOptions(abortSignal));
  }
}

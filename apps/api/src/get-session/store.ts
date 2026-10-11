import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { sendOptions } from '../shared/aws.js';
import { keys } from '../start-session/store.js';
import type { SessionView } from '../start-session/types.js';
import { validOwner, validSession, validSessionRelations, validUuid } from '../start-session/validation.js';

export interface SessionReader {
  read(sessionId: string, ownerId: string, abortSignal?: AbortSignal): Promise<SessionView | undefined>;
}

export class DynamoSessionReader implements SessionReader {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly table: string,
  ) {
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(table)) throw new Error('Invalid session table');
  }

  async read(sessionId: string, ownerId: string, abortSignal?: AbortSignal): Promise<SessionView | undefined> {
    if (!validUuid(sessionId) || sessionId !== sessionId.toLowerCase() || !validOwner(ownerId)) {
      throw new Error('Invalid session read');
    }
    abortSignal?.throwIfAborted();
    const result = await this.client.send(
      new GetCommand({ TableName: this.table, Key: keys.session(sessionId), ConsistentRead: true }),
      sendOptions(abortSignal),
    );
    abortSignal?.throwIfAborted();
    if (result.Item === undefined) return undefined;
    const data: unknown = result.Item.data;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error('Invalid stored session record');
    }
    // Do not expose another learner's record, including its validation failures.
    if (!('ownerId' in data)) throw new Error('Invalid stored session owner');
    if (data.ownerId !== ownerId) return undefined;
    if (!validSession(data) || !validSessionRelations(data)) throw new Error('Invalid stored session record');
    if (data.view.id !== sessionId) throw new Error('Stored session identity mismatch');
    if (data.accessGrant.timeLimitSeconds !== data.view.timeLimitSeconds) {
      throw new Error('Stored session access grant mismatch');
    }
    return data.view;
  }
}

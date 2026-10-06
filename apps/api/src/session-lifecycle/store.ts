import { sendOptions } from '../shared/aws.js';
import { GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient, TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { validSession, validSessionRelations, validTaskArn } from '../start-session/validation.js';
import type { LaunchFailure, SessionRecord } from '../start-session/types.js';
import type { LifecycleStorePort } from './ports.js';

const sessionKey = (id: string) => ({ PK: `SESSION#${id}`, SK: 'STATE' });
const activeKey = (ownerId: string) => ({ PK: `USER#${ownerId}`, SK: 'ACTIVE' });
type ReleaseUpdate = Omit<NonNullable<NonNullable<TransactWriteCommandInput['TransactItems']>[number]['Update']>,
  'TableName' | 'Key' | 'UpdateExpression'> & { UpdateExpression?: string };

function sessionFrom(item: Record<string, unknown> | undefined): SessionRecord {
  const data = item?.data;
  if (!validSession(data) || !validSessionRelations(data)) throw new Error('Invalid stored session record');
  return data;
}

function conditionalFailure(error: unknown): boolean {
  return error instanceof Error
    && ['ConditionalCheckFailedException', 'TransactionCanceledException'].includes(error.name);
}

export class LifecycleStore implements LifecycleStorePort {
  constructor(private readonly client: DynamoDBDocumentClient, private readonly table: string) {}

  async session(id: string, abortSignal?: AbortSignal): Promise<SessionRecord | undefined> {
    const command = new GetCommand({ TableName: this.table, Key: sessionKey(id), ConsistentRead: true });
    const result = await this.client.send(command, sendOptions(abortSignal));
    if (!result.Item) return undefined;
    return sessionFrom(result.Item);
  }

  async saveTask(id: string, taskArn: string, abortSignal?: AbortSignal): Promise<SessionRecord> {
    if (!validTaskArn(taskArn)) throw new Error('Invalid ECS task ARN');
    const command = new UpdateCommand({
      TableName: this.table,
      Key: sessionKey(id),
      UpdateExpression: 'SET #data.#taskArn = :taskArn',
      ConditionExpression: 'attribute_exists(PK) AND (#data.#taskArn = :empty OR #data.#taskArn = :taskArn)',
      ExpressionAttributeNames: { '#data': 'data', '#taskArn': 'taskArn' },
      ExpressionAttributeValues: { ':empty': null, ':taskArn': taskArn },
      ReturnValues: 'ALL_NEW',
    });
    const result = await this.client.send(command, sendOptions(abortSignal));
    return sessionFrom(result.Attributes);
  }

  async failStartWithoutTask(id: string, endedAt: string, failure: LaunchFailure,
    abortSignal?: AbortSignal): Promise<SessionRecord> {
    return this.releaseActive(id, endedAt, {
      UpdateExpression: 'SET #data.#view.#status = :error, #data.#view.#reason = :reason, '
        + '#data.#view.#endedAt = :completedAt, #data.#launchFailure = :launchFailure',
      ConditionExpression: '#data.#taskArn = :empty AND '
        + '(#data.#view.#status = :provisioning OR (#data.#view.#status = :error AND #data.#view.#reason = :reason))',
      ExpressionAttributeNames: { '#view': 'view', '#reason': 'statusReason', '#endedAt': 'endedAt',
        '#taskArn': 'taskArn', '#launchFailure': 'launchFailure' },
      ExpressionAttributeValues: { ':error': 'error', ':reason': 'start_failed', ':empty': null,
        ':provisioning': 'provisioning', ':launchFailure': failure },
    }, abortSignal);
  }

  async markStartFailed(id: string, endedAt: string, abortSignal?: AbortSignal): Promise<SessionRecord> {
    const command = new UpdateCommand({
      TableName: this.table,
      Key: sessionKey(id),
      UpdateExpression: 'SET #data.#view.#status = :error, #data.#view.#reason = :reason, #data.#view.#endedAt = :endedAt',
      ConditionExpression: '#data.#view.#status = :provisioning AND #data.#deadline <= :endedAt',
      ExpressionAttributeNames: {
        '#data': 'data', '#view': 'view', '#status': 'status', '#reason': 'statusReason',
        '#endedAt': 'endedAt', '#deadline': 'provisioningDeadline',
      },
      ExpressionAttributeValues: {
        ':error': 'error', ':reason': 'start_failed', ':endedAt': endedAt, ':provisioning': 'provisioning',
      },
      ReturnValues: 'ALL_NEW',
    });
    try {
      const result = await this.client.send(command, sendOptions(abortSignal));
      return sessionFrom(result.Attributes);
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
      const saved = await this.session(id, abortSignal);
      if (saved?.view.status === 'error' && saved.view.statusReason === 'start_failed') return saved;
      throw error;
    }
  }

  async completeStartFailure(id: string, completedAt: string, abortSignal?: AbortSignal): Promise<SessionRecord> {
    return this.releaseActive(id, completedAt, {
      ConditionExpression: '#data.#view.#status = :error AND #data.#view.#reason = :reason',
      ExpressionAttributeNames: { '#view': 'view', '#reason': 'statusReason' },
      ExpressionAttributeValues: { ':error': 'error', ':reason': 'start_failed' },
    }, abortSignal);
  }

  private async releaseActive(id: string, completedAt: string,
    update: ReleaseUpdate,
    abortSignal?: AbortSignal): Promise<SessionRecord> {
    const complete = (session: SessionRecord) => session.view.status === 'error'
      && session.view.statusReason === 'start_failed' && session.provisioningCleanup.status === 'complete';
    const current = await this.session(id, abortSignal);
    if (!current) throw new Error('Session does not exist');
    if (complete(current)) return current;
    const command = new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: this.table,
        Key: sessionKey(id),
        UpdateExpression: (update.UpdateExpression ? `${update.UpdateExpression}, ` : 'SET ')
          + '#data.#cleanup.#status = :complete, #data.#cleanup.#completedAt = :completedAt',
        ConditionExpression: `(${update.ConditionExpression}) AND #data.#cleanup.#status = :pending`,
        ExpressionAttributeNames: { ...update.ExpressionAttributeNames,
          '#data': 'data', '#status': 'status', '#cleanup': 'provisioningCleanup', '#completedAt': 'completedAt' },
        ExpressionAttributeValues: { ...update.ExpressionAttributeValues,
          ':pending': 'pending', ':complete': 'complete', ':completedAt': completedAt },
      } },
      { Delete: {
        TableName: this.table,
        Key: activeKey(current.ownerId),
        ConditionExpression: '#data.#sessionId = :sessionId',
        ExpressionAttributeNames: { '#data': 'data', '#sessionId': 'sessionId' },
        ExpressionAttributeValues: { ':sessionId': id },
      } },
    ] });
    try {
      await this.client.send(command, sendOptions(abortSignal));
    } catch (error) {
      const saved = await this.session(id, abortSignal);
      if (saved && complete(saved)) return saved;
      throw error;
    }
    const saved = await this.session(id, abortSignal);
    if (!saved) throw new Error('Session disappeared after cleanup commit');
    return saved;
  }
}

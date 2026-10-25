import { randomUUID } from 'node:crypto';
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { retryDynamoConflict } from '../../../../packages/dynamodb/src/conflict-retry.js';
import { keys } from '../start-session/store.js';
import { validOwner, validPlan, validUuid } from '../start-session/validation.js';
import type { Plan } from '../start-session/types.js';
import { effectivePlan } from '../shared/plan.js';

export interface DemoUpgradeResult {
  changed: boolean;
  expiresAt: string | null;
}
interface Receipt {
  schemaVersion: 1;
  ownerId: string;
  requestId: string;
  demoExpiresAt: string;
  result: DemoUpgradeResult;
}

export class DemoUpgradeConflict extends Error {}
export class DemoUpgradeUnavailable extends Error {}
export const demoReceiptKey = (owner: string, requestId: string) => ({
  PK: `USER#${owner}`,
  SK: `DEMO_UPGRADE#${requestId}`,
});

function validReceipt(value: unknown): value is Receipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const saved = value as Receipt;
  return (
    Object.keys(saved).sort().join(',') === 'demoExpiresAt,ownerId,requestId,result,schemaVersion' &&
    saved.schemaVersion === 1 &&
    validOwner(saved.ownerId) &&
    validUuid(saved.requestId) &&
    typeof saved.demoExpiresAt === 'string' &&
    Number.isFinite(Date.parse(saved.demoExpiresAt)) &&
    !!saved.result &&
    typeof saved.result === 'object' &&
    Object.keys(saved.result).sort().join(',') === 'changed,expiresAt' &&
    typeof saved.result.changed === 'boolean' &&
    (saved.result.expiresAt === null ||
      (typeof saved.result.expiresAt === 'string' && Number.isFinite(Date.parse(saved.result.expiresAt)))) &&
    (!saved.result.changed || saved.result.expiresAt === saved.demoExpiresAt)
  );
}

function conditionalConflict(error: unknown) {
  if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') return false;
  const reasons = (error as Error & { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  return (
    Array.isArray(reasons) &&
    reasons.some((reason) => reason.Code === 'ConditionalCheckFailed') &&
    reasons.every((reason) => reason.Code === 'None' || reason.Code === 'ConditionalCheckFailed')
  );
}

/** Writes only the authenticated learner's plan and duplicate-safe receipt. Never launches a task. */
export class DemoUpgradeStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async activate(
    owner: string,
    requestId: string,
    expiresAt: string,
    now: () => number,
    signal: AbortSignal,
  ): Promise<DemoUpgradeResult> {
    const receiptKey = demoReceiptKey(owner, requestId);
    const read = async (key: { PK: string; SK: string }) => {
      const result = await this.client.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true }), {
        abortSignal: signal,
      });
      if (result.Item && result.Item.data === undefined) throw new Error('Invalid stored demo record.');
      return result.Item?.data as unknown;
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      signal.throwIfAborted();
      const saved = await read(receiptKey);
      if (saved !== undefined) {
        if (!validReceipt(saved) || saved.ownerId !== owner || saved.requestId !== requestId)
          throw new Error('Invalid demo receipt.');
        if (saved.demoExpiresAt !== expiresAt) throw new DemoUpgradeConflict();
        return saved.result;
      }
      const snapshot = await read(keys.plan(owner));
      if (snapshot !== undefined && !validPlan(snapshot)) throw new Error('Invalid account plan.');
      const clock = now();
      if (!Number.isFinite(clock)) throw new Error('Invalid demo clock.');
      if (Date.parse(expiresAt) <= clock) throw new DemoUpgradeUnavailable();
      const plan = snapshot as Plan | undefined;
      const current = effectivePlan(plan, clock);
      const result = {
        changed: current.plan !== 'pro',
        expiresAt: current.plan === 'pro' ? current.planExpiresAt : expiresAt,
      };
      const receipt: Receipt = { schemaVersion: 1, ownerId: owner, requestId, demoExpiresAt: expiresAt, result };
      const condition =
        plan === undefined
          ? { ConditionExpression: 'attribute_not_exists(PK)' }
          : {
              ConditionExpression: '#data = :expected',
              ExpressionAttributeNames: { '#data': 'data' },
              ExpressionAttributeValues: { ':expected': plan },
            };
      const command = new TransactWriteCommand({
        ClientRequestToken: randomUUID(),
        TransactItems: [
          {
            Put: {
              TableName: this.table,
              Item: { ...receiptKey, data: receipt },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          result.changed
            ? {
                Put: {
                  TableName: this.table,
                  Item: { ...keys.plan(owner), data: { plan: 'pro', expiresAt } },
                  ...condition,
                },
              }
            : { ConditionCheck: { TableName: this.table, Key: keys.plan(owner), ...condition } },
        ],
      });
      try {
        await retryDynamoConflict(() => this.client.send(command, { abortSignal: signal }), signal);
        return result;
      } catch (error) {
        // Re-read after a competing plan/receipt write. Unknown failures keep the result uncertain.
        if (!conditionalConflict(error)) throw error;
      }
    }
    throw new Error('Demo upgrade contention limit reached.');
  }
}

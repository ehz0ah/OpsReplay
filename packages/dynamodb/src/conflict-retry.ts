import { setTimeout as delay } from 'node:timers/promises';
import {
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandOutput,
  type UpdateCommandOutput,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

/** Only contention is retryable here. Failed conditions and unknown cancellations are not. */
export function isDynamoTransactionConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TransactionConflictException') return true;
  if (error.name !== 'TransactionCanceledException') return false;
  const reasons = (error as Error & { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  return (
    Array.isArray(reasons) &&
    reasons.some((reason) => reason.Code === 'TransactionConflict') &&
    reasons.every((reason) => reason.Code === 'None' || reason.Code === 'TransactionConflict')
  );
}

export function sendDynamoWrite(
  client: DynamoDBDocumentClient,
  command: TransactWriteCommand,
  options?: { abortSignal?: AbortSignal },
): Promise<TransactWriteCommandOutput>;
export function sendDynamoWrite(
  client: DynamoDBDocumentClient,
  command: UpdateCommand,
  options?: { abortSignal?: AbortSignal },
): Promise<UpdateCommandOutput>;
export function sendDynamoWrite(
  client: DynamoDBDocumentClient,
  command: TransactWriteCommand | UpdateCommand,
  options?: { abortSignal?: AbortSignal },
): Promise<TransactWriteCommandOutput | UpdateCommandOutput> {
  return retryDynamoConflict<TransactWriteCommandOutput | UpdateCommandOutput>(
    () => (command instanceof TransactWriteCommand ? client.send(command, options) : client.send(command, options)),
    options?.abortSignal,
  );
}

/** Reuse the exact request, including its transaction token. At most four attempts. */
export async function retryDynamoConflict<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      if (signal?.aborted || attempt === 3 || !isDynamoTransactionConflict(error)) throw error;
      await delay(25 * 2 ** attempt, undefined, { signal });
    }
  }
}

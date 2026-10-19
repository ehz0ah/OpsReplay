import { historyKey } from '../../../../packages/session/src/history.js';
import { createHash, randomUUID } from 'node:crypto';
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { isDynamoTransactionConflict } from '../../../../packages/dynamodb/src/conflict-retry.js';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalJson } from '../../../../packages/session/src/canonical.js';
import {
  isReviewBundle,
  isReviewSubmission,
  isReviewExercise,
  reviewResult,
  reviewKeys,
  exerciseView,
  type ReviewBundle,
  type ReviewRequest,
  type ReviewSubmission,
  type ReviewExercise,
} from '../../../../packages/content/src/review.js';
import { validPlan, validUuid } from '../start-session/validation.js';
import { keys } from '../start-session/store.js';
import { effectivePlan } from '../shared/plan.js';
import { ActionError } from '../shared/action.js';
export interface SavedReview {
  schemaVersion: 1;
  ownerId: string;
  requestHash: string;
  accessGrant: { plan: 'free' | 'pro'; grantedAt: string };
  exercise: ReviewExercise;
  view: ReviewSubmission;
}
function hash(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
interface ReviewPointer {
  version: string;
  sha256: string;
  plan: 'free' | 'pro';
}
function pointerValue(value: unknown): value is ReviewPointer {
  return (
    object(value) &&
    Object.keys(value).length === 3 &&
    typeof value.version === 'string' &&
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value.version) &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    ['free', 'pro'].includes(String(value.plan))
  );
}
export class ReviewStore {
  constructor(
    readonly client: DynamoDBDocumentClient,
    readonly table: string,
    private readonly now = Date.now,
  ) {}
  async get(Key: object, signal: AbortSignal): Promise<unknown> {
    return (
      await this.client.send(new GetCommand({ TableName: this.table, Key, ConsistentRead: true }), {
        abortSignal: signal,
      })
    ).Item?.data;
  }
  async owned(id: string, owner: string, signal: AbortSignal): Promise<SavedReview> {
    const saved = await this.get(reviewKeys.submission(id), signal);
    if (!object(saved) || saved.ownerId !== owner) throw new ActionError('NOT_FOUND');
    if (
      Object.keys(saved).length !== 6 ||
      saved.schemaVersion !== 1 ||
      !isReviewSubmission(saved.view) ||
      saved.view.id !== id ||
      !isReviewExercise(saved.exercise) ||
      saved.exercise.id !== saved.view.exerciseId ||
      saved.exercise.version !== saved.view.exerciseVersion ||
      typeof saved.requestHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(saved.requestHash) ||
      !object(saved.accessGrant) ||
      Object.keys(saved.accessGrant).length !== 2 ||
      !['free', 'pro'].includes(String(saved.accessGrant.plan)) ||
      saved.accessGrant.grantedAt !== saved.view.submittedAt
    )
      throw new Error('Invalid saved review.');
    return saved as unknown as SavedReview;
  }
  async published(id: string, signal: AbortSignal): Promise<{ pointer: ReviewPointer; bundle: ReviewBundle }> {
    const pointer = await this.get(reviewKeys.published(id), signal);
    if (!pointer) throw new ActionError('NOT_FOUND');
    if (!pointerValue(pointer)) throw new Error('Invalid review pointer.');
    const bundle = await this.get(reviewKeys.version(id, pointer.version), signal);
    if (
      !isReviewBundle(bundle) ||
      bundle.status !== 'published' ||
      bundle.id !== id ||
      bundle.version !== pointer.version ||
      bundle.plan !== pointer.plan ||
      hash(bundle) !== pointer.sha256
    )
      throw new Error('Invalid review content.');
    return { pointer, bundle };
  }
  async plan(owner: string, required: 'free' | 'pro', signal: AbortSignal) {
    const saved = await this.get(keys.plan(owner), signal);
    if (saved !== undefined && !validPlan(saved)) throw new Error('Invalid plan.');
    if (required === 'pro' && effectivePlan(saved, this.now()).plan !== 'pro') throw new ActionError('PLAN_REQUIRED');
    return saved;
  }
  async exercise(id: string, owner: string, signal: AbortSignal) {
    const { bundle } = await this.published(id, signal);
    await this.plan(owner, bundle.plan, signal);
    return exerciseView(bundle);
  }
  async submit(id: string, request: ReviewRequest, owner: string, signal: AbortSignal): Promise<ReviewSubmission> {
    const requestHash = hash({ id, ...request }),
      submissionId = randomUUID();
    for (let attempt = 0; attempt < 4; attempt++) {
      signal.throwIfAborted();
      const receipt = await this.get(reviewKeys.receipt(owner, request.requestId), signal);
      if (receipt) {
        if (
          !object(receipt) ||
          Object.keys(receipt).length !== 2 ||
          receipt.requestHash !== requestHash ||
          !validUuid(receipt.id)
        )
          throw new ActionError('IDEMPOTENCY_CONFLICT');
        const saved = await this.owned(receipt.id, owner, signal);
        if (saved.requestHash !== requestHash) throw new Error('Invalid review receipt.');
        return { ...saved.view, replayed: true };
      }
      const { pointer, bundle } = await this.published(id, signal);
      if (bundle.version !== request.exerciseVersion) throw new ActionError('VERSION_UNAVAILABLE');
      const plan = await this.plan(owner, bundle.plan, signal);
      const seen = await this.get(reviewKeys.seen(owner, id), signal);
      if (
        seen !== undefined &&
        (!object(seen) ||
          Object.keys(seen).length !== 1 ||
          !Number.isSafeInteger(seen.count) ||
          (seen.count as number) < 1)
      )
        throw new Error('Invalid review progress.');
      const seenCount = object(seen) ? (seen.count as number) : 0;
      let matched;
      try {
        matched = reviewResult(bundle, request.flags);
      } catch {
        throw new ActionError('INVALID_REQUEST');
      }
      if (bundle.plan === 'pro' && effectivePlan(plan, this.now()).plan !== 'pro')
        throw new ActionError('PLAN_REQUIRED');
      const submittedAt = new Date(this.now()).toISOString();
      const view: ReviewSubmission = {
        id: submissionId,
        exerciseId: id,
        exerciseVersion: bundle.version,
        submittedAt,
        answerInformed: seen !== undefined,
        replayed: false,
        flags: structuredClone(request.flags),
        ...matched,
      };
      const saved: SavedReview = {
        schemaVersion: 1,
        ownerId: owner,
        requestHash,
        accessGrant: { plan: bundle.plan, grantedAt: submittedAt },
        exercise: exerciseView(bundle),
        view,
      };
      if (!isReviewSubmission(view) || Buffer.byteLength(canonicalJson(saved)) > 300 * 1024)
        throw new Error('Review exceeds its bound.');
      const same = (Key: object, before: unknown) => ({
        ConditionCheck: {
          TableName: this.table,
          Key,
          ConditionExpression: before === undefined ? 'attribute_not_exists(PK)' : '#d = :same',
          ...(before === undefined
            ? {}
            : { ExpressionAttributeNames: { '#d': 'data' }, ExpressionAttributeValues: { ':same': before } }),
        },
      });
      try {
        await this.client.send(
          new TransactWriteCommand({
            ClientRequestToken: randomUUID(),
            TransactItems: [
              {
                Put: {
                  TableName: this.table,
                  Item: {
                    ...historyKey(owner, 'review', submittedAt, submissionId),
                    data: { schemaVersion: 1, id: submissionId, at: submittedAt },
                  },
                  ConditionExpression: 'attribute_not_exists(PK)',
                },
              },
              same(reviewKeys.published(id), pointer),
              same(keys.plan(owner), plan),
              {
                Put: {
                  TableName: this.table,
                  Item: { ...reviewKeys.receipt(owner, request.requestId), data: { id: submissionId, requestHash } },
                  ConditionExpression: 'attribute_not_exists(PK)',
                },
              },
              {
                Put: {
                  TableName: this.table,
                  Item: { ...reviewKeys.submission(submissionId), data: saved },
                  ConditionExpression: 'attribute_not_exists(PK)',
                },
              },
              {
                Put: {
                  TableName: this.table,
                  Item: { ...reviewKeys.seen(owner, id), data: { count: seenCount + 1 } },
                  ConditionExpression: seen === undefined ? 'attribute_not_exists(PK)' : '#d = :same',
                  ...(seen === undefined
                    ? {}
                    : { ExpressionAttributeNames: { '#d': 'data' }, ExpressionAttributeValues: { ':same': seen } }),
                },
              },
            ],
          }),
          { abortSignal: signal },
        );
        return view;
      } catch (error) {
        const savedReceipt = await this.get(reviewKeys.receipt(owner, request.requestId), signal);
        if (savedReceipt) continue;
        const conditional =
          error instanceof Error &&
          error.name === 'TransactionCanceledException' &&
          (error as Error & { CancellationReasons?: { Code?: string }[] }).CancellationReasons?.every((reason) =>
            ['None', 'ConditionalCheckFailed', 'TransactionConflict'].includes(reason.Code ?? ''),
          );
        if (!isDynamoTransactionConflict(error) && !conditional) throw error;
        await delay(25 * 2 ** attempt, undefined, { signal });
      }
    }
    throw new ActionError('CONFLICT');
  }
}

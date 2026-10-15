import { retryDynamoConflict } from '../../../../packages/dynamodb/src/conflict-retry.js';
import { GetCommand, TransactGetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { bootstrapHandler, BootstrapError } from '../bootstrap/handler.js';
import { keys } from '../start-session/store.js';
import { validLock, validPlan, validSession, validSessionRelations } from '../start-session/validation.js';
import { effectivePlan } from '../shared/plan.js';
export function createGetAccountHandler(
  client: DynamoDBDocumentClient,
  table: string,
  now = Date.now,
  log?: (value: object) => void,
) {
  return bootstrapHandler(
    'get_account',
    '/v1/me',
    true,
    async (event, owner, signal) => {
      if (Object.keys(event.multiValueQueryStringParameters ?? event.queryStringParameters ?? {}).length)
        throw new BootstrapError('INVALID_REQUEST');
      if (!owner) throw new BootstrapError('UNAUTHENTICATED');
      const request = new TransactGetCommand({
        TransactItems: [keys.plan(owner), keys.active(owner)].map((Key) => ({ Get: { TableName: table, Key } })),
      });
      const snapshot = await retryDynamoConflict(() => client.send(request, { abortSignal: signal }), signal);
      if (snapshot.Responses?.length !== 2) throw new Error('Incomplete account snapshot');
      const planItem = snapshot.Responses[0]?.Item;
      const activeItem = snapshot.Responses[1]?.Item;
      if ((planItem && !validPlan(planItem.data)) || (activeItem && !validLock(activeItem.data)))
        throw new Error('Invalid account record');
      const plan = planItem?.data;
      const active = activeItem?.data;
      if (active) {
        const session = (
          await client.send(
            new GetCommand({ TableName: table, Key: keys.session(active.sessionId), ConsistentRead: true }),
            { abortSignal: signal },
          )
        ).Item?.data;
        if (
          !validSession(session) ||
          !validSessionRelations(session) ||
          session.ownerId !== owner ||
          session.view.id !== active.sessionId
        )
          throw new Error('Invalid active session reference');
      }
      return { ...effectivePlan(plan, now()), activeSessionId: active?.sessionId ?? null };
    },
    log,
  );
}

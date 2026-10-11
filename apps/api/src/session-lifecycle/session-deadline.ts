import { randomUUID } from 'node:crypto';
import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  UpdateScheduleCommand,
  ConflictException,
  ResourceNotFoundException,
  type SchedulerClient,
  type GetScheduleCommandOutput,
} from '@aws-sdk/client-scheduler';
import type { SessionRecord } from '../start-session/types.js';
import type { SessionDeadlinePort } from './reconcile.js';
import { sendOptions } from '../shared/aws.js';

export interface SessionDeadlineConfiguration {
  groupName: string;
  functionArn: string;
  targetRoleArn: string;
}
const expression = (time: number) => `at(${new Date(Math.ceil(time / 1000) * 1000).toISOString().slice(0, 19)})`;
/** A distinct ready timer does not race with provisioning's immutable create token. */
export class SessionDeadline implements SessionDeadlinePort {
  constructor(
    private readonly client: SchedulerClient,
    private readonly configuration: SessionDeadlineConfiguration,
  ) {}
  private async get(name: string, signal?: AbortSignal) {
    try {
      return await this.client.send(
        new GetScheduleCommand({ Name: name, GroupName: this.configuration.groupName }),
        sendOptions(signal),
      );
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return undefined;
      throw error;
    }
  }
  private target(id: string) {
    return {
      Arn: this.configuration.functionArn,
      RoleArn: this.configuration.targetRoleArn,
      Input: JSON.stringify({ sessionId: id }),
      RetryPolicy: { MaximumEventAgeInSeconds: 900, MaximumRetryAttempts: 20 },
    };
  }
  private matches(value: GetScheduleCommandOutput, id: string, scheduleExpression: string) {
    const target = this.target(id);
    return (
      value.GroupName === this.configuration.groupName &&
      value.State === 'ENABLED' &&
      value.ScheduleExpression === scheduleExpression &&
      value.ScheduleExpressionTimezone === 'UTC' &&
      value.ActionAfterCompletion === 'DELETE' &&
      value.FlexibleTimeWindow?.Mode === 'OFF' &&
      value.Target?.Arn === target.Arn &&
      value.Target.RoleArn === target.RoleArn &&
      value.Target.Input === target.Input &&
      value.Target.RetryPolicy?.MaximumEventAgeInSeconds === 900 &&
      value.Target.RetryPolicy.MaximumRetryAttempts === 20
    );
  }
  async ensure(session: SessionRecord, now: Date, signal?: AbortSignal): Promise<void> {
    if (
      session.view.status !== 'ready' ||
      session.view.endsAt === null ||
      now.getTime() >= Date.parse(session.view.endsAt)
    )
      return;
    const name = `${session.scheduleName}-ready`;
    const scheduleExpression = expression(Math.max(Date.parse(session.view.endsAt), now.getTime() + 60_000));
    const existing = await this.get(name, signal);
    if (existing && this.matches(existing, session.view.id, scheduleExpression)) return;
    const input = {
      Name: name,
      GroupName: this.configuration.groupName,
      ClientToken: randomUUID(),
      Description: 'Check the saved OpsReplay attempt deadline',
      ScheduleExpression: scheduleExpression,
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' as const },
      ActionAfterCompletion: 'DELETE' as const,
      State: 'ENABLED' as const,
      Target: this.target(session.view.id),
    };
    try {
      await this.client.send(
        existing ? new UpdateScheduleCommand(input) : new CreateScheduleCommand(input),
        sendOptions(signal),
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      const saved = await this.get(name, signal);
      if (saved && this.matches(saved, session.view.id, scheduleExpression)) return;
      if (error instanceof ConflictException || error instanceof ResourceNotFoundException)
        throw new Error('Session timer repair must be retried.');
      throw error;
    }
  }
  async delete(session: SessionRecord, signal?: AbortSignal): Promise<void> {
    await Promise.all(
      [session.scheduleName, `${session.scheduleName}-recovery`, `${session.scheduleName}-ready`].map(async (name) => {
        try {
          await this.client.send(
            new DeleteScheduleCommand({
              Name: name,
              GroupName: this.configuration.groupName,
              ClientToken: randomUUID(),
            }),
            sendOptions(signal),
          );
        } catch (error) {
          if (!(error instanceof ResourceNotFoundException)) throw error;
        }
      }),
    );
  }
}
export function loadDeadlineConfiguration(environment: NodeJS.ProcessEnv): SessionDeadlineConfiguration {
  const groupName = environment.SCHEDULER_GROUP_NAME;
  const functionArn =
    environment.SESSION_RECONCILE_FUNCTION_ARN ??
    (environment.AWS_PARTITION &&
    environment.AWS_REGION &&
    environment.AWS_ACCOUNT_ID &&
    environment.AWS_LAMBDA_FUNCTION_NAME
      ? `arn:${environment.AWS_PARTITION}:lambda:${environment.AWS_REGION}:${environment.AWS_ACCOUNT_ID}:function:${environment.AWS_LAMBDA_FUNCTION_NAME}`
      : undefined);
  const targetRoleArn = environment.SCHEDULER_TARGET_ROLE_ARN;
  if (
    !groupName ||
    !/^[0-9A-Za-z-_.]{1,64}$/.test(groupName) ||
    !functionArn ||
    !/^arn:aws[a-z-]*:lambda:[a-z0-9-]+:[0-9]{12}:function:[A-Za-z0-9-_]+$/.test(functionArn) ||
    !targetRoleArn ||
    !/^arn:aws[a-z-]*:iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]+$/.test(targetRoleArn)
  )
    throw new Error('Session timer configuration is invalid.');
  return { groupName, functionArn, targetRoleArn };
}

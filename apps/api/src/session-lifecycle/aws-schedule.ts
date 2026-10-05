import {
  ConflictException,
  CreateScheduleCommand,
  GetScheduleCommand,
  ResourceNotFoundException,
  SchedulerClient,
} from '@aws-sdk/client-scheduler';
import type { GetScheduleCommandOutput, Target } from '@aws-sdk/client-scheduler';
import type { SessionRecord } from '../start-session/types.js';
import type { ProvisioningSchedulePort } from './ports.js';
import { createAwsTransport } from './transport.js';

interface ScheduleConfiguration {
  groupName: string;
  expiryFunctionArn: string;
  targetRoleArn: string;
}

const ceilToSecond = (time: number) => Math.ceil(time / 1000) * 1000;
const at = (date: Date) => `at(${new Date(ceilToSecond(date.getTime())).toISOString().slice(0, 19)})`;

function parseAt(expression: string | undefined): number | undefined {
  const match = /^at\((\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\)$/.exec(expression ?? '');
  return match?.[1] ? Date.parse(`${match[1]}Z`) : undefined;
}

export class ProvisioningSchedule implements ProvisioningSchedulePort {
  constructor(private readonly client: SchedulerClient, private readonly configuration: ScheduleConfiguration) {}

  private target(sessionId: string): Target {
    return {
      Arn: this.configuration.expiryFunctionArn,
      RoleArn: this.configuration.targetRoleArn,
      Input: JSON.stringify({ sessionId }),
      RetryPolicy: { MaximumEventAgeInSeconds: 900, MaximumRetryAttempts: 20 },
    };
  }

  private validExisting(existing: GetScheduleCommandOutput, session: SessionRecord, now: Date): boolean {
    const scheduledAt = parseAt(existing.ScheduleExpression);
    const latestSafeWakeup = Math.max(
      Date.parse(session.launchRecoveryDeadline),
      ceilToSecond(now.getTime() + 60_000),
    );
    return existing.GroupName === this.configuration.groupName
      && existing.State === 'ENABLED'
      && existing.FlexibleTimeWindow?.Mode === 'OFF'
      && existing.ActionAfterCompletion === 'DELETE'
      && existing.ScheduleExpressionTimezone === 'UTC'
      && scheduledAt !== undefined
      && scheduledAt >= Date.parse(session.provisioningDeadline)
      && scheduledAt <= latestSafeWakeup
      && existing.Target?.Arn === this.configuration.expiryFunctionArn
      && existing.Target?.RoleArn === this.configuration.targetRoleArn
      && existing.Target?.Input === JSON.stringify({ sessionId: session.view.id })
      && existing.Target?.RetryPolicy?.MaximumEventAgeInSeconds === 900
      && existing.Target?.RetryPolicy?.MaximumRetryAttempts === 20;
  }

  private async get(name: string, abortSignal?: AbortSignal): Promise<GetScheduleCommandOutput | undefined> {
    try {
      return await this.client.send(new GetScheduleCommand({
        GroupName: this.configuration.groupName, Name: name,
      }), abortSignal ? { abortSignal } : undefined);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return undefined;
      throw error;
    }
  }

  async ensure(session: SessionRecord, now: Date, abortSignal?: AbortSignal): Promise<void> {
    const existing = await this.get(session.scheduleName, abortSignal);
    if (existing) {
      if (!this.validExisting(existing, session, now)) throw new Error('Existing provisioning schedule does not match the session');
      return;
    }
    const deadline = new Date(session.provisioningDeadline);
    const scheduleAt = deadline.getTime() > now.getTime() ? deadline : new Date(now.getTime() + 60_000);
    const command = new CreateScheduleCommand({
      Name: session.scheduleName,
      GroupName: this.configuration.groupName,
      ClientToken: session.view.id,
      Description: 'Expire an OpsReplay session that did not become ready',
      ScheduleExpression: at(scheduleAt),
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
      ActionAfterCompletion: 'DELETE',
      State: 'ENABLED',
      Target: this.target(session.view.id),
    });
    try {
      await this.client.send(command, abortSignal ? { abortSignal } : undefined);
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      const raced = await this.get(session.scheduleName, abortSignal);
      if (!raced || !this.validExisting(raced, session, now)) throw error;
    }
  }
}

export function createSchedulerClient() {
  return new SchedulerClient({ maxAttempts: 2, requestHandler: createAwsTransport() });
}

export function loadScheduleConfiguration(environment: NodeJS.ProcessEnv): ScheduleConfiguration {
  const groupName = environment.SCHEDULER_GROUP_NAME;
  const expiryFunctionArn = environment.PROVISIONING_EXPIRY_FUNCTION_ARN;
  const targetRoleArn = environment.SCHEDULER_TARGET_ROLE_ARN;
  if (!groupName || !/^[0-9A-Za-z-_.]{1,64}$/.test(groupName)) throw new Error('SCHEDULER_GROUP_NAME is invalid');
  const lambdaArn = /^arn:aws[a-z-]*:lambda:[a-z0-9-]+:[0-9]{12}:function:[A-Za-z0-9-_]+$/;
  const roleArn = /^arn:aws[a-z-]*:iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_\/-]+$/;
  if (!expiryFunctionArn || !lambdaArn.test(expiryFunctionArn)) throw new Error('PROVISIONING_EXPIRY_FUNCTION_ARN is invalid');
  if (!targetRoleArn || !roleArn.test(targetRoleArn)) throw new Error('SCHEDULER_TARGET_ROLE_ARN is invalid');
  return { groupName, expiryFunctionArn, targetRoleArn };
}

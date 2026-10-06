import {
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';
import type { EcsLaunchArguments } from '../start-session/types.js';
import { launchFailureReasons } from '../start-session/types.js';
import type { EnvironmentPort, EnvironmentTask } from './ports.js';
import { LaunchRejectedError } from './ports.js';
import { createAwsTransport, sendOptions } from '../shared/aws.js';

const TASK_PAGE_LIMIT = 100;

export class FargateEnvironment implements EnvironmentPort {
  constructor(private readonly client: ECSClient) {}

  async launch(arguments_: EcsLaunchArguments, abortSignal?: AbortSignal): Promise<string> {
    const output = await this.client.send(new RunTaskCommand(arguments_), sendOptions(abortSignal));
    if (output.failures?.length && (output.tasks?.length ?? 0) === 0) {
      const reasons = [...new Set(output.failures.map(({ reason }) =>
        launchFailureReasons.find(known => known === reason) ?? 'UNKNOWN'))];
      const capacity = reasons.every(reason => reason === 'CAPACITY' || reason.startsWith('RESOURCE:'));
      throw new LaunchRejectedError({ kind: capacity ? 'capacity' : 'configuration', reasons });
    }
    const taskArn = output.tasks?.length === 1 ? output.tasks[0]?.taskArn : undefined;
    if (!taskArn) throw new Error('ECS did not return exactly one task');
    return taskArn;
  }

  async findActive(cluster: string, startedBy: string, abortSignal?: AbortSignal): Promise<EnvironmentTask[]> {
    // startedBy is the only ECS task filter allowed in this request. Its default
    // desired status is RUNNING, which also includes tasks whose last status is PENDING.
    const output = await this.client.send(new ListTasksCommand({
      cluster, startedBy, maxResults: TASK_PAGE_LIMIT,
    }), sendOptions(abortSignal));
    if (output.nextToken) throw new Error('ECS task scan exceeded its safety bound');
    const candidates = [...new Set(output.taskArns ?? [])];
    if (candidates.length === 0) return [];
    const found: EnvironmentTask[] = [];
    for (let index = 0; index < candidates.length; index += 100) {
      const output = await this.client.send(new DescribeTasksCommand({
        cluster, tasks: candidates.slice(index, index + 100),
      }), sendOptions(abortSignal));
      found.push(...(output.tasks ?? [])
        .filter(task => task.startedBy === startedBy && task.taskArn && task.lastStatus !== 'STOPPED')
        .map(task => ({ taskArn: task.taskArn!, lastStatus: task.lastStatus })));
    }
    return found;
  }

  async describe(cluster: string, taskArn: string, abortSignal?: AbortSignal): Promise<EnvironmentTask | undefined> {
    const output = await this.client.send(new DescribeTasksCommand({
      cluster, tasks: [taskArn],
    }), sendOptions(abortSignal));
    const task = output.tasks?.find(candidate => candidate.taskArn === taskArn);
    return task?.taskArn ? { taskArn: task.taskArn, lastStatus: task.lastStatus } : undefined;
  }

  async stop(cluster: string, taskArn: string, reason: string, abortSignal?: AbortSignal): Promise<void> {
    await this.client.send(new StopTaskCommand({ cluster, task: taskArn, reason }), sendOptions(abortSignal));
  }
}

export function createEcsClient() {
  return new ECSClient({ maxAttempts: 2, requestHandler: createAwsTransport() });
}

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoAttemptStore } from '../../../../packages/session/src/attempt-store.js';
import { FargateEnvironment, createEcsClient } from './aws-environment.js';
import { createSchedulerClient, ProvisioningSchedule } from './aws-schedule.js';
import { MonitorBootstrapFile, createS3Client } from './aws-bootstrap.js';
import { createProvisionSession } from './provision.js';
import { createPublishRecordingWork } from './publish-recording-work.js';
import { LifecycleStore } from './store.js';
import { SessionDeadline, loadDeadlineConfiguration } from './session-deadline.js';
import { createReconcileSession } from './reconcile.js';
import { createAwsTransport } from '../shared/aws.js';

export function createLifecycleRuntime(environment: NodeJS.ProcessEnv = process.env) {
  const table = environment.SESSION_TABLE_NAME;
  if (!table || !/^[A-Za-z0-9_.-]{3,255}$/.test(table)) throw new Error('SESSION_TABLE_NAME is invalid.');
  const dynamo = DynamoDBDocumentClient.from(
    new DynamoDBClient({ maxAttempts: 2, requestHandler: createAwsTransport(2000) }),
  );
  const sessions = new LifecycleStore(dynamo, table);
  const tasks = new FargateEnvironment(createEcsClient());
  const scheduler = createSchedulerClient();
  const configuration = loadDeadlineConfiguration(environment);
  const provision = createProvisionSession({
    store: sessions,
    environment: tasks,
    bootstrap: new MonitorBootstrapFile(createS3Client()),
    schedule: new ProvisioningSchedule(scheduler, {
      groupName: configuration.groupName,
      expiryFunctionArn: configuration.functionArn,
      targetRoleArn: configuration.targetRoleArn,
    }),
  });
  const reconcile = createReconcileSession({
    sessions,
    attempts: new DynamoAttemptStore(dynamo, table),
    environment: tasks,
    schedules: new SessionDeadline(scheduler, configuration),
    provision,
    publish: createPublishRecordingWork({ store: sessions }),
  });
  return { table, dynamo, sessions, reconcile };
}

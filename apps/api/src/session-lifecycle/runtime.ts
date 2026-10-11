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
import { DynamoFinaliseStore } from '../../../../packages/session/src/finalise-store.js';
import { createFinaliseSession } from '../../../../packages/session/src/finalise.js';
import { readManifest } from '../../../../packages/session/src/manifest.js';
import { RecordedEvidenceReader } from '../../../../packages/session/src/recorded-evidence.js';

export function createLifecycleRuntime(environment: NodeJS.ProcessEnv = process.env) {
  const table = environment.SESSION_TABLE_NAME;
  if (!table || !/^[A-Za-z0-9_.-]{3,255}$/.test(table)) throw new Error('SESSION_TABLE_NAME is invalid.');
  const dynamo = DynamoDBDocumentClient.from(
    new DynamoDBClient({ maxAttempts: 2, requestHandler: createAwsTransport(2000) }),
  );
  const recordingBucket = environment.RECORDING_BUCKET_NAME;
  if (!recordingBucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(recordingBucket))
    throw new Error('RECORDING_BUCKET_NAME is invalid.');
  const sessions = new LifecycleStore(dynamo, table);
  const evidence = new RecordedEvidenceReader(dynamo, table, createS3Client(), recordingBucket);
  const finalise = createFinaliseSession({
    store: new DynamoFinaliseStore(dynamo, table),
    manifest: (session, signal) => readManifest(dynamo, table, session, signal),
    evidence: (session, signal) => evidence.read(session, signal),
  });
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
    finalise,
  });
  return { table, dynamo, sessions, reconcile };
}

import { S3Client } from '@aws-sdk/client-s3';
import { client, table } from '../bootstrap/runtime.js';
import { createAwsTransport } from '../shared/aws.js';
import { loadPublicApiPolicy, withPublicApiPolicy } from '../shared/public-api.js';
import { createGetLearnHandler } from './handler.js';
const bucket = process.env.RECORDING_BUCKET_NAME;
if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('RECORDING_BUCKET_NAME is required');
export const handler = withPublicApiPolicy(
  createGetLearnHandler(
    client,
    table!,
    new S3Client({ maxAttempts: 2, requestHandler: createAwsTransport(2000) }),
    bucket,
  ),
  loadPublicApiPolicy(process.env),
);

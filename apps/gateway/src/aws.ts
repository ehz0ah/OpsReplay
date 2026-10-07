import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export const gatewayAwsLimits = Object.freeze({
  maximumAttempts: 2,
  connectionTimeoutMs: 500,
  dynamoRequestTimeoutMs: 2_000,
  s3RequestTimeoutMs: 7_000,
});

function transport(requestTimeout: number): NodeHttpHandler {
  return new NodeHttpHandler({
    connectionTimeout: gatewayAwsLimits.connectionTimeoutMs,
    requestTimeout,
    throwOnRequestTimeout: true,
  });
}

export interface GatewayAwsClients {
  dynamo: DynamoDBDocumentClient;
  s3: S3Client;
  close(): void;
}

export function createGatewayAwsClients(): GatewayAwsClients {
  const dynamoBase = new DynamoDBClient({
    maxAttempts: gatewayAwsLimits.maximumAttempts,
    requestHandler: transport(gatewayAwsLimits.dynamoRequestTimeoutMs),
  });
  const dynamo = DynamoDBDocumentClient.from(dynamoBase);
  const s3 = new S3Client({
    maxAttempts: gatewayAwsLimits.maximumAttempts,
    requestHandler: transport(gatewayAwsLimits.s3RequestTimeoutMs),
  });
  return {
    dynamo,
    s3,
    close: () => {
      dynamo.destroy();
      s3.destroy();
    },
  };
}

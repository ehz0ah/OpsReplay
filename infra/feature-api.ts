import { Aws, Duration, Fn, RemovalPolicy } from 'aws-cdk-lib';
import type { CfnCondition } from 'aws-cdk-lib';
import { CfnMethod, CfnResource } from 'aws-cdk-lib/aws-apigateway';
import { Code, Function, CfnPermission, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Role, ServicePrincipal, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';
export interface FeatureApiOptions {
  apiId: string;
  parentId: string;
  authorizerId: string;
  enabled: CfnCondition;
  origin: string;
  tableArn: string;
  environment: Record<string, string>;
}
/** One deployed function per action. The helper shares definitions, never Lambda calls. */
export function featureAction(
  scope: Construct,
  id: string,
  options: FeatureApiOptions,
  input: {
    bundle: string;
    resourceId: string;
    path: string;
    method?: 'GET' | 'POST';
    leadingKeys: string[];
    actions?: string[];
    objectArn?: string;
    timeoutSeconds?: number;
  },
) {
  const logs = new LogGroup(scope, `${id}Logs`, {
    retention: RetentionDays.ONE_WEEK,
    removalPolicy: RemovalPolicy.DESTROY,
  });
  const role = new Role(scope, `${id}Role`, { assumedBy: new ServicePrincipal('lambda.amazonaws.com') });
  logs.grantWrite(role);
  role.addToPolicy(
    new PolicyStatement({
      actions: input.actions ?? ['dynamodb:GetItem'],
      resources: [options.tableArn],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': input.leadingKeys } },
    }),
  );
  if (input.objectArn)
    role.addToPolicy(new PolicyStatement({ actions: ['s3:GetObject'], resources: [input.objectArn] }));
  const fn = new Function(scope, id, {
    runtime: Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: Code.fromAsset(fileURLToPath(new URL(`../dist/${input.bundle}/`, import.meta.url))),
    role,
    logGroup: logs,
    environment: options.environment,
    memorySize: 256,
    timeout: Duration.seconds(input.timeoutSeconds ?? 10),
    reservedConcurrentExecutions: Fn.conditionIf(options.enabled.logicalId, 2, 0) as unknown as number,
  });
  const method = new CfnMethod(scope, `${id}Method`, {
    restApiId: options.apiId,
    resourceId: input.resourceId,
    httpMethod: input.method ?? 'GET',
    authorizationType: 'COGNITO_USER_POOLS',
    authorizerId: options.authorizerId,
    apiKeyRequired: false,
    operationName: input.bundle,
    integration: {
      type: 'AWS_PROXY',
      integrationHttpMethod: 'POST',
      timeoutInMillis: 8000,
      uri: Fn.join('', [
        'arn:',
        Aws.PARTITION,
        ':apigateway:',
        Aws.REGION,
        ':lambda:path/2015-03-31/functions/',
        fn.functionArn,
        '/invocations',
      ]),
    },
  });
  method.cfnOptions.condition = options.enabled;
  const permission = new CfnPermission(scope, `${id}Permission`, {
    action: 'lambda:InvokeFunction',
    functionName: fn.functionArn,
    principal: 'apigateway.amazonaws.com',
    sourceArn: Fn.join('', [
      'arn:',
      Aws.PARTITION,
      ':execute-api:',
      Aws.REGION,
      ':',
      Aws.ACCOUNT_ID,
      ':',
      options.apiId,
      `/*/${input.method ?? 'GET'}${input.path}`,
    ]),
  });
  permission.cfnOptions.condition = options.enabled;
  return { method, fn, role };
}
export function featureResource(
  scope: Construct,
  id: string,
  options: FeatureApiOptions,
  path: string,
  parent = options.parentId,
) {
  const resource = new CfnResource(scope, id, { restApiId: options.apiId, parentId: parent, pathPart: path });
  resource.cfnOptions.condition = options.enabled;
  return resource;
}

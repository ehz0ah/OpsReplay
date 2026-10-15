import { Aws, CfnOutput, CfnParameter, Duration, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { FederatedPrincipal, PolicyStatement, Role } from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

/** Defines the separate least-privilege identity used by reviewed content publication. */
export class ContentPublicationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const providerArn = new CfnParameter(this, 'GitHubOidcProviderArn', {
      type: 'String',
      allowedPattern: 'arn:aws[a-z-]*:iam::[0-9]{12}:oidc-provider/token\\.actions\\.githubusercontent\\.com',
    });
    const contentTableArn = new CfnParameter(this, 'ContentTableArn', {
      type: 'String',
      allowedPattern: 'arn:aws[a-z-]*:dynamodb:[a-z0-9-]+:[0-9]{12}:table/[A-Za-z0-9_.-]+',
      description: 'Existing session/content table. Publication can read and conditionally create content items only.',
    });
    const role = new Role(this, 'ContentPublisherRole', {
      assumedBy: new FederatedPrincipal(
        providerArn.valueAsString,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub':
              'repo:ehz0ah@130889443/OpsReplay@1378586293:environment:aws-checkpoint',
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
      description: 'Inspects the reference runtime and conditionally publishes reviewed immutable content.',
      maxSessionDuration: Duration.hours(1),
    });
    role.addToPolicy(
      new PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
        resources: [contentTableArn.valueAsString],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['CONTENT#*', 'CATALOG#PUBLIC'] } },
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['ecr:BatchGetImage'],
        resources: [
          `arn:${Aws.PARTITION}:ecr:${Aws.REGION}:${Aws.ACCOUNT_ID}:repository/opsreplay/monitor`,
          `arn:${Aws.PARTITION}:ecr:${Aws.REGION}:${Aws.ACCOUNT_ID}:repository/opsreplay/challenge-wrong-upstream-port`,
        ],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['ecs:DescribeTaskDefinition'],
        // ECS does not support resource-level permissions for DescribeTaskDefinition.
        resources: ['*'],
      }),
    );
    new CfnOutput(this, 'GitHubContentPublisherRoleArn', { value: role.roleArn });
  }
}

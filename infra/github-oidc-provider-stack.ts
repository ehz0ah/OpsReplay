import { CfnOutput, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { CfnOIDCProvider } from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export class GitHubOidcProviderStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const provider = new CfnOIDCProvider(this, 'GitHubOidcProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIdList: ['sts.amazonaws.com'],
    });

    new CfnOutput(this, 'GitHubOidcProviderArn', { value: provider.ref });
  }
}

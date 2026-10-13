import { Aws, CfnCondition, CfnOutput, CfnParameter, Fn, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';

/** CloudFront-scope WAF resources must be owned in us-east-1. */
export class TerminalEdgeProtectionStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    if (props?.env?.region !== undefined && props.env.region !== 'us-east-1') {
      throw new Error('Terminal edge protection must be deployed in us-east-1.');
    }
    super(scope, id, { ...props, env: { ...props?.env, region: 'us-east-1' } });
    const enabled = new CfnParameter(this, 'EnableTerminalEdgeProtection', {
      type: 'String',
      default: 'false',
      allowedValues: ['false', 'true'],
      description: 'Create the CloudFront Web ACL before activating the terminal runtime.',
    });
    const protectionEnabled = new CfnCondition(this, 'TerminalEdgeProtectionEnabled', {
      expression: Fn.conditionEquals(enabled.valueAsString, 'true'),
    });
    const rateLimit = new CfnParameter(this, 'TerminalUpgradeRateLimitPerIp', {
      type: 'Number',
      default: 300,
      minValue: 10,
      maxValue: 2_000_000_000,
      description: 'Terminal path requests per viewer IP in each 60-second WAF window. AWS WAF limits are approximate.',
    });
    const webAcl = new CfnWebACL(this, 'TerminalWebAcl', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'opsreplay-terminal-web-acl',
        sampledRequestsEnabled: false,
      },
      rules: [
        {
          name: 'terminal-connection-rate-limit',
          priority: 0,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              aggregateKeyType: 'IP',
              evaluationWindowSec: 60,
              limit: rateLimit.valueAsNumber,
              scopeDownStatement: {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: 'EXACTLY',
                  searchString: '/v1/terminal',
                  textTransformations: [{ priority: 0, type: 'NONE' }],
                },
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'opsreplay-terminal-connection-rate-limit',
            sampledRequestsEnabled: false,
          },
        },
      ],
    });
    webAcl.cfnOptions.condition = protectionEnabled;
    new CfnOutput(this, 'TerminalEdgeWebAclArn', { value: webAcl.attrArn, condition: protectionEnabled });
    new CfnOutput(this, 'TerminalEdgeProtectionRegion', { value: Aws.REGION });
  }
}

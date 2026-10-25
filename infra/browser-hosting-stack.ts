import { Aws, CfnCondition, CfnOutput, CfnParameter, Fn, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import {
  CfnDistribution,
  CfnFunction,
  CfnOriginAccessControl,
  CfnResponseHeadersPolicy,
  CachePolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
export const browserRouteCode = `function handler(event) {
  var request=event.request;
  if (request.uri==='/' || request.uri==='/challenges' || request.uri==='/auth/callback' || request.uri==='/history' || request.uri==='/pricing' || request.uri==='/upgrade' || request.uri==='/account' || /^\\/review-submissions\\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(request.uri) || /^\\/(?:learn|reviews)(?:\\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/.test(request.uri) || /^\\/sessions\\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?:\\/debrief)?$/.test(request.uri)) request.uri='/index.html';
  return request;
}`;
export class BrowserHostingStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    this.templateOptions.description = 'OpsReplay static learner browser. No runtime or data ownership.';
    const sources = [
      ['ApiOrigin', 'https://[a-z0-9]+\\.execute-api\\.[a-z0-9-]+\\.amazonaws\\.com'],
      ['CognitoAuthorityOrigin', 'https://cognito-idp\\.[a-z0-9-]+\\.amazonaws\\.com'],
      ['CognitoLoginOrigin', 'https://[a-z0-9-]+\\.auth\\.[a-z0-9-]+\\.amazoncognito\\.com'],
      ['TerminalOrigin', 'wss://[a-z0-9]+\\.cloudfront\\.net'],
      ['RecordingOrigin', 'https://(?:[a-z0-9.-]+\\.)?s3(?:\\.[a-z0-9-]+)?\\.amazonaws\\.com'],
    ] as const;
    const allowed = sources.map(([name, pattern]) => {
      const parameter = new CfnParameter(this, name, {
        type: 'String',
        default: '',
        allowedPattern: `^(?:|${pattern})$`,
        description: 'Exact connection origin. Leave empty only before application configuration is published.',
      });
      const set = new CfnCondition(this, `${name}Configured`, {
        expression: Fn.conditionNot(Fn.conditionEquals(parameter.valueAsString, '')),
      });
      return Fn.conditionIf(set.logicalId, parameter.valueAsString, "'self'").toString();
    });
    const bucket = new Bucket(this, 'BrowserAssets', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const access = new CfnOriginAccessControl(this, 'BrowserOriginAccess', {
      originAccessControlConfig: {
        name: Fn.join('-', [Aws.STACK_NAME, 'browser']),
        originAccessControlOriginType: 's3',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
      },
    });
    const routes = new CfnFunction(this, 'BrowserRoutes', {
      name: Fn.join('-', [Aws.STACK_NAME, 'routes']),
      autoPublish: true,
      functionConfig: { comment: 'Rewrite only learner browser routes to index.html', runtime: 'cloudfront-js-2.0' },
      functionCode: browserRouteCode,
    });
    const headers = new CfnResponseHeadersPolicy(this, 'BrowserHeaders', {
      responseHeadersPolicyConfig: {
        name: Fn.join('-', [Aws.STACK_NAME, 'browser']),
        securityHeadersConfig: {
          contentSecurityPolicy: {
            contentSecurityPolicy: Fn.join(' ', [
              "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'",
              ...allowed,
              "; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
            ]),
            override: true,
          },
          contentTypeOptions: { override: true },
          frameOptions: { frameOption: 'DENY', override: true },
          referrerPolicy: { referrerPolicy: 'no-referrer', override: true },
          strictTransportSecurity: { accessControlMaxAgeSec: 31536000, includeSubdomains: true, override: true },
        },
      },
    });
    const distribution = new CfnDistribution(this, 'BrowserDistribution', {
      distributionConfig: {
        enabled: true,
        comment: 'OpsReplay static learner browser',
        httpVersion: 'http2',
        ipv6Enabled: true,
        viewerCertificate: { cloudFrontDefaultCertificate: true },
        origins: [
          {
            id: 'browser-assets',
            domainName: bucket.bucketRegionalDomainName,
            originAccessControlId: access.attrId,
            s3OriginConfig: { originAccessIdentity: '' },
          },
        ],
        defaultCacheBehavior: {
          targetOriginId: 'browser-assets',
          viewerProtocolPolicy: 'https-only',
          allowedMethods: ['GET', 'HEAD'],
          cachedMethods: ['GET', 'HEAD'],
          cachePolicyId: CachePolicy.CACHING_DISABLED.cachePolicyId,
          compress: true,
          responseHeadersPolicyId: headers.ref,
          functionAssociations: [{ eventType: 'viewer-request', functionArn: routes.attrFunctionArn }],
        },
        cacheBehaviors: [
          {
            pathPattern: 'assets/*',
            targetOriginId: 'browser-assets',
            viewerProtocolPolicy: 'https-only',
            allowedMethods: ['GET', 'HEAD'],
            cachedMethods: ['GET', 'HEAD'],
            cachePolicyId: CachePolicy.CACHING_OPTIMIZED.cachePolicyId,
            compress: true,
            responseHeadersPolicyId: headers.ref,
          },
        ],
        customErrorResponses: [403, 404].map((errorCode) => ({ errorCode, errorCachingMinTtl: 0 })),
      },
    });
    bucket.addToResourcePolicy(
      new PolicyStatement({
        principals: [new ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['s3:GetObject'],
        resources: [
          bucket.arnForObjects('index.html'),
          bucket.arnForObjects('config.json'),
          bucket.arnForObjects('assets/*'),
          bucket.arnForObjects('learn/*'),
        ],
        conditions: {
          StringEquals: {
            'AWS:SourceArn': Fn.join('', [
              'arn:',
              Aws.PARTITION,
              ':cloudfront::',
              Aws.ACCOUNT_ID,
              ':distribution/',
              distribution.ref,
            ]),
          },
        },
      }),
    );
    bucket.policy!.applyRemovalPolicy(RemovalPolicy.RETAIN);
    for (const [name, value] of [
      ['BrowserBucketName', bucket.bucketName],
      ['BrowserDistributionId', distribution.ref],
      ['BrowserOrigin', Fn.join('', ['https://', distribution.attrDomainName])],
      ['BrowserCallbackUrl', Fn.join('', ['https://', distribution.attrDomainName, '/auth/callback'])],
      ['BrowserLogoutUrl', Fn.join('', ['https://', distribution.attrDomainName, '/'])],
    ] as const)
      new CfnOutput(this, name, { value });
  }
}

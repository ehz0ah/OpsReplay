import type { LaunchConfiguration } from './types.js';

const clusterArn = /^arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]{12}:cluster\/[A-Za-z0-9_-]+$/;
const subnetId = /^subnet-[a-f0-9]{8,17}$/;
const securityGroupId = /^sg-[a-f0-9]{8,17}$/;
const platformVersion = /^[0-9]+(?:\.[0-9]+){2}$/;
const containerName = /^[A-Za-z0-9_-]{1,255}$/;
const bucketArn = /^arn:aws[a-z-]*:s3:::[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function identifiers(environment: NodeJS.ProcessEnv, name: string, pattern: RegExp, maximum: number): string[] {
  const values = required(environment, name)
    .split(',')
    .map((value) => value.trim());
  if (
    values.length > maximum ||
    values.some((value) => !pattern.test(value)) ||
    new Set(values).size !== values.length
  ) {
    throw new Error(`${name} is invalid`);
  }
  return values;
}

export function loadLaunchConfiguration(environment: NodeJS.ProcessEnv): LaunchConfiguration {
  const configuration = {
    clusterArn: required(environment, 'ECS_CLUSTER_ARN'),
    subnetIds: identifiers(environment, 'ECS_SUBNET_IDS', subnetId, 16),
    securityGroupIds: identifiers(environment, 'ECS_SECURITY_GROUP_IDS', securityGroupId, 5),
    platformVersion: required(environment, 'ECS_PLATFORM_VERSION'),
    monitorContainerName: required(environment, 'MONITOR_CONTAINER_NAME'),
    secretBucketArn: required(environment, 'MONITOR_SECRET_BUCKET_ARN'),
  };
  if (!clusterArn.test(configuration.clusterArn)) throw new Error('ECS_CLUSTER_ARN is invalid');
  if (!platformVersion.test(configuration.platformVersion)) throw new Error('ECS_PLATFORM_VERSION is invalid');
  if (!containerName.test(configuration.monitorContainerName)) throw new Error('MONITOR_CONTAINER_NAME is invalid');
  if (!bucketArn.test(configuration.secretBucketArn)) throw new Error('MONITOR_SECRET_BUCKET_ARN is invalid');
  return configuration;
}

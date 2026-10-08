# AWS checkpoint foundation

Status: implemented locally, AWS deployment pending
Date: 8 October 2026
Owner: Cloud contributors

## Context

The session and recording stack expects an ECS cluster, private subnets, security
groups, VPC endpoints, an environment execution role, and pinned images. The NUS AWS
account does not yet contain these resources. Local synthesis cannot validate Fargate,
managed service behavior, or network isolation.

The first AWS run is temporary and has a small budget. It must not create the complete
hosted product before the current recording path is tested.

## Decision

Create a separate `OpsReplayCheckpointFoundation` CDK stack. It contains one VPC with
one isolated workload subnet and no internet gateway, NAT gateway, or public address.
One Availability Zone is sufficient for this temporary functional checkpoint. It is not
the production availability design.

Private tasks reach ECR API, ECR Docker, and CloudWatch Logs through interface
endpoints. They reach S3 and DynamoDB through gateway endpoints. The environment
security group allows HTTPS only to the interface-endpoint group and the deployment-
supplied S3 prefix list, plus DNS to the VPC resolver. It has no inbound rule until the
application stack grants the gateway access to the monitor port.

The stack creates an ECS cluster and three immutable, scan-on-push ECR repositories for
the gateway, monitor, and first Challenge. It also creates the environment log group
and an ECS execution role. The role can pull only the monitor and first-Challenge
repositories and write only that log group. It is an execution role and is not exposed
inside either container. The application stack grants its private bootstrap bucket to
this role through the bucket policy.

The stack exports the values already required by `SessionStartStack`. AWS-managed S3
and DynamoDB prefix-list IDs remain deployment parameters because CloudFormation does
not expose them from gateway endpoint resources and offline synthesis must not perform
account lookups.

The stack is disposable. Its log group and ECR repositories use deletion policies, and
repository deletion also removes contained checkpoint images. Repository lifecycle
rules keep at most five images. The VPC endpoints have hourly cost, so the stack must
exist only during an approved test window.

Use the standard CDK bootstrap stack for deployment assets. The bootstrap S3 bucket
stages Lambda ZIP files for CloudFormation. It is not application storage and is not
used during normal Lambda invocation. Application container images remain in the three
dedicated repositories.

## Limits and validation

This increment does not create an environment task definition, run an ECS task, publish
an image, enable a Lambda, or create a public route. It does not add an ALB, API Gateway,
Cognito, Route 53, frontend hosting, or LLM infrastructure.

Template tests verify the resource allow-list, private subnet, endpoint set, security-
group egress, execution-role permissions, repository controls, deletion policies, and
outputs. These tests do not prove AWS deployment. Review the CDK bootstrap template and
CloudFormation diff before the first account change. Deploy only with the `opsreplay`
profile in `ap-southeast-1`, then destroy the checkpoint stack after the test.

# AWS checkpoint activation runbook

Status: reviewed procedure only. Do not deploy without an approved AWS test window.

This runbook prepares one disposable OpsReplay checkpoint in `ap-southeast-1`. Every AWS
command must name the `opsreplay` profile and Region. The terminal edge WAF stack is in
`us-east-1`. Stop if the account, resource owner, image digest, origin, or approved budget
differs from the review record. Review the [CloudFront ingress limits](../decisions/cloudfront-terminal-ingress.md)
before approval. Its default certificate cannot enforce a custom TLS minimum, and the
private origin hop uses HTTP.

This runbook assumes the selected retained table, buckets, and user pool are already
owned by `OpsReplayDurableResources`. If they are not, stop and follow the
[durable-resource adoption runbook](aws-durable-resource-adoption.md). Do not deploy a
new durable set as part of a temporary checkpoint.

## 1. Prepare the parameter record

Copy [the example mapping](../../infra/checkpoint-runtime-parameters.example.json) to an
untracked file. Replace every angle-bracket value from reviewed foundation outputs and
approved resources. Keep `EnableGatewayPath=true` and
`EnableSessionAdmission=false`. Do not store tokens, passwords, private keys, or session
data in the mapping. Copy the table stream ARN, Monitor bootstrap bucket ARN, recording
bucket name, and user pool ARN from the reviewed durable-stack outputs. Use the same
Monitor bootstrap bucket ARN for the foundation permission and runtime import. Also copy
[the edge mapping](../../infra/terminal-edge-parameters.example.json)
to an untracked file. Its parameters belong only to `OpsReplayTerminalEdgeProtection`.
The edge stack supplies the Web ACL ARN for the workload mapping. The workload outputs
the terminal WSS URL. Do not supply an external terminal hostname or ACM certificate.

Use the same reviewed mapping for `cdk diff` and `cdk deploy`. Convert each entry to an
explicit `--parameters OpsReplaySessionStart:<key>=<value>` argument. Use the
`OpsReplayTerminalEdgeProtection:` prefix for edge parameters. Do not use shell
defaults for account, Region, digest, ARN, subnet, security group, origin, or hostname.
Before the runtime diff, confirm that the foundation `MonitorBootstrapBucketArn` output
equals the value in this mapping.

## 2. Run read-only preflight checks

Authenticate and record the exact account before any change:

```sh
aws sso login --profile opsreplay
aws sts get-caller-identity --profile opsreplay --region ap-southeast-1
aws cloudformation describe-stacks --stack-name OpsReplayDurableResources --profile opsreplay --region ap-southeast-1
aws cloudformation describe-stacks --stack-name OpsReplayCheckpointFoundation --profile opsreplay --region ap-southeast-1
```

Confirm the approved budget and current service quotas. Do not infer capacity from local
tests or default AWS documentation.

```sh
aws budgets describe-budgets --account-id <confirmed-account-id> --profile opsreplay --region us-east-1
aws service-quotas list-service-quotas --service-code lambda --profile opsreplay --region ap-southeast-1
aws service-quotas list-service-quotas --service-code fargate --profile opsreplay --region ap-southeast-1
aws service-quotas list-service-quotas --service-code elasticloadbalancing --profile opsreplay --region ap-southeast-1
aws service-quotas list-service-quotas --service-code cloudfront --profile opsreplay --region us-east-1
aws service-quotas list-service-quotas --service-code wafv2 --profile opsreplay --region us-east-1
aws service-quotas list-service-quotas --service-code vpc --profile opsreplay --region ap-southeast-1
aws cloudfront list-vpc-origins --profile opsreplay --region us-east-1
aws cloudfront list-distributions --profile opsreplay --region us-east-1
aws ec2 describe-managed-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing --profile opsreplay --region ap-southeast-1
```

Lambda keeps 100 executions unreserved. With the default parameters, this stack reserves
61 executions in runtime-only mode: 4 for reconciliation, 1 for sweep, 4 for owner end,
12 across the three result reads, 4 for recording-work publication, 4 for hint release,
16 for terminal tickets, and 16 for session status. Opening admission adds 8 for
StartSession, for a total of 69. The account quota must therefore be at least 161 before
runtime activation and 169 before admission, plus reserved concurrency already assigned
to other functions in the Region. If a burst parameter changes, recalculate the
requirement as follows:

```text
runtime only = 100 + other reservations + 29 + TerminalTicketBurstLimit + SessionStatusBurstLimit
admission open = runtime only + StartSessionBurstLimit
```

Stop if the confirmed account quota does not satisfy the applicable total. Do not reduce
cleanup concurrency only to fit the quota. Request a quota increase or keep the runtime
disabled. See [AWS Lambda concurrency](https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html).

Confirm that each pinned image exists and review its current scan result. Use the exact
Gateway, reference Monitor, and Challenge repository digests from the publication
evidence.

```sh
aws ecr describe-images --repository-name opsreplay-gateway --image-ids imageDigest=<gateway-digest> --profile opsreplay --region ap-southeast-1
aws ecr describe-image-scan-findings --repository-name opsreplay-gateway --image-id imageDigest=<gateway-digest> --profile opsreplay --region ap-southeast-1
aws ecr describe-images --repository-name opsreplay/monitor --image-ids imageDigest=<reference-monitor-digest> --profile opsreplay --region ap-southeast-1
aws ecr describe-image-scan-findings --repository-name opsreplay/monitor --image-id imageDigest=<reference-monitor-digest> --profile opsreplay --region ap-southeast-1
aws ecr describe-images --repository-name opsreplay/challenge-wrong-upstream-port --image-ids imageDigest=<challenge-digest> --profile opsreplay --region ap-southeast-1
aws ecr describe-image-scan-findings --repository-name opsreplay/challenge-wrong-upstream-port --image-id imageDigest=<challenge-digest> --profile opsreplay --region ap-southeast-1
```

Record the exact CloudFront-managed prefix-list ID in the workload mapping. Its weight
is 55 against the inbound security-group rule quota. Confirm available private IPv4
addresses and the attached VPC internet gateway. Workload subnets must have no internet
or NAT route. Do not edit the AWS-owned CloudFront service security group.

Record `AvailabilityZoneId` for both workload subnets and check each ID against the
[supported Regions and AZ exceptions for VPC origins](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html).
Use AZ IDs, not account-specific AZ names. Stop before deployment if either AZ is
unsupported. The current AWS table lists `ap-southeast-1` without an AZ exception;
recheck it for the approved test window.

Confirm the candidate task, identity client, network ownership, and absence
of unintended public routes. The task definition must have no task role and must use the
reviewed digest-only images.

```sh
aws ecs describe-task-definition --task-definition <reference-task-definition-arn> --profile opsreplay --region ap-southeast-1
aws cognito-idp describe-user-pool --user-pool-id <user-pool-id> --profile opsreplay --region ap-southeast-1
aws cognito-idp describe-user-pool-client --user-pool-id <user-pool-id> --client-id <public-client-id> --profile opsreplay --region ap-southeast-1
aws ec2 describe-subnets --subnet-ids <workload-a> <workload-b> --profile opsreplay --region ap-southeast-1 \
  --query 'Subnets[].{SubnetId:SubnetId,VpcId:VpcId,AvailabilityZone:AvailabilityZone,AvailabilityZoneId:AvailabilityZoneId,AvailableIpAddressCount:AvailableIpAddressCount}' --output table
aws ec2 describe-internet-gateways --filters Name=attachment.vpc-id,Values=<vpc-id> --profile opsreplay --region ap-southeast-1
aws ec2 describe-route-tables --filters Name=vpc-id,Values=<vpc-id> --profile opsreplay --region ap-southeast-1
aws ec2 describe-security-groups --group-ids <environment-sg> <endpoint-sg> --profile opsreplay --region ap-southeast-1
```

Build the application bundles, synthesize locally, and inspect a read-only diff. The
`--no-change-set` option avoids creating a temporary CloudFormation change set. For an
ingress PR checkpoint, record the exact commit and synthesize from that worktree. Do not
merge first to enable the test. Keep image publication restricted to `main`. The approved
test must use existing reviewed images or a separately approved publication procedure.

```sh
npm run quality
npm run check
npm run infra:test
npm run infra:synth
npm run infra:cdk -- diff OpsReplayTerminalEdgeProtection --no-change-set --profile opsreplay --region us-east-1 <reviewed-edge-parameter-arguments>
npm run infra:cdk -- diff OpsReplaySessionStart --no-change-set --profile opsreplay --region ap-southeast-1 <reviewed-parameter-arguments>
```

Stop if the diff widens IAM, adds public task addresses, enables ExpireProvisioning,
changes a durable-resource identifier, or opens admission. The foundation diff may grant
its new execution role `GetBucketLocation` and `sessions/*` `GetObject` on only the
selected Monitor bootstrap bucket.

## 3. Prepare the runtime with admission closed

The following are write operations. Run them only after approval and final diff review.
The edge Region needs its own CDK bootstrap prerequisite. Review and approve its bootstrap
template if the account has no suitable `us-east-1` bootstrap. Do not deploy all stacks.
First deploy edge protection:

```sh
npm run infra:cdk -- deploy OpsReplayTerminalEdgeProtection --profile opsreplay --region us-east-1 <reviewed-edge-parameter-arguments>
aws cloudformation describe-stacks --stack-name OpsReplayTerminalEdgeProtection --profile opsreplay --region us-east-1
```

Record `TerminalEdgeWebAclArn` in the workload mapping. Confirm the ACL has scope
`CLOUDFRONT`, the reviewed rate rule, and the same account. Review the workload diff again
with that exact ARN, then deploy with admission closed:

```sh
npm run infra:cdk -- deploy OpsReplaySessionStart --profile opsreplay --region ap-southeast-1 <reviewed-parameter-arguments>
```

Verify that StartSession reserved concurrency is zero. Verify the Gateway targets are
healthy and private, the CloudFront distribution and VPC origin are deployed, the
distribution references the exact edge Web ACL, the recording publisher and lifecycle triggers are enabled, and
ExpireProvisioning remains at zero. Verify that the existing-session hint action is enabled
with its reviewed concurrency and throttle limits. Inspect CloudFormation events, ECS service events,
Lambda configurations, EventBridge rules, the DynamoDB stream mapping, alarms, dead
letters, and logs. Do not create a learner session yet.

Record the generated `TerminalGatewayUrl`, distribution ID, VPC origin ID, and internal
ALB DNS output. Confirm the ALB is internal and its only ingress is the reviewed
CloudFront prefix list on TCP 80. Confirm the target remains private on TCP 8080.
Test the public HTTPS/WSS path, negotiated TLS, wrong Origin, missing or reused ticket,
query rejection, blocked ordinary paths, and no direct public ALB access.

Leave the same terminal socket connected for more than 10 minutes with no typing,
commands, resizing, or terminal output. Keep Gateway Ping and normal learner-presence
heartbeats active; protocol traffic is expected. Use an attempt whose remaining time
limit exceeds the test duration. Disable automatic reconnect during this check so a
replacement socket cannot hide a disconnect. Record the start and end times, whether
the original socket survives, and any close time and code. Test reconnects separately.
Record the configured Gateway Ping interval (currently 20 seconds), CloudFront origin
read timeout (30 seconds), and ALB idle timeout (60 seconds). Keep the Ping interval below
the origin read timeout. Do not infer established-socket timeout behaviour from a busy
terminal or from local tests.

Test the WAF threshold with an approved bounded request load, including spoofed
`X-Forwarded-For` values. Expect approximate enforcement. Record handshake latency and
terminal responsiveness. Keep browser credentials and terminal output out of logs.

Run the approved operator-controlled candidate task check. Confirm private bootstrap
delivery, Monitor TLS, terminal access through the Gateway, recording, task stop, and no
learner access to AWS credentials. This check must not mark draft content as published.

## 4. Publish content, then open admission

Publish only the reviewed immutable content record that binds the verified task revision
and image digests. Re-read the saved record before opening admission.

Change only `EnableSessionAdmission` from `false` to `true`, review the diff, and deploy
the same parameter set. Confirm that only StartSession reserved concurrency changes.
Run the controlled full flow with the approved accounts and session count. Record real
latency, retries, event delivery, cost, and failure evidence. Exercise duplicate start,
harmful restart, Gateway replacement, interrupted recording, learner end, recovery, and
time limit without manually editing session state.

## 5. Close, drain, and remove

First change only `EnableSessionAdmission` back to `false`. Confirm that StartSession is
zero while Gateway, terminal tickets, hint release, owner end, reconciliation, sweep,
recording, and result reads remain enabled.

Wait until every approved attempt has a terminal outcome, task stop is confirmed,
recording work is terminal, required finalisation is saved, playback export is complete
or explicitly recorded as unavailable, and no lifecycle or recording work remains.
Inspect alarms, dead-letter queues, the lifecycle and recording indexes, ECS tasks, and
retained table and bucket contents. Do not use reserved concurrency zero as a drain
operation and do not clear locks or records manually.

Only then set `EnableGatewayPath=false`, review the diff, and deploy. Wait for CloudFront
distribution and VPC-origin removal before disabling or destroying
`OpsReplayTerminalEdgeProtection` in `us-east-1`. Check that no other distribution uses
the ACL. Remove disposable foundation resources only under their separate ownership
procedure. Keep `OpsReplayDurableResources`; its table, buckets, and user pool are not
part of checkpoint teardown. Inventory their ongoing cost and obtain explicit approval
before deleting retained data. Record the final account, Region,
stack events, image digests, test results, retained resources, and teardown evidence in
both Regions. Preserve pre-existing bootstrap stacks and account resources.

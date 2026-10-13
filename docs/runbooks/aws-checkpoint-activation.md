# AWS checkpoint activation runbook

Status: reviewed procedure only. Do not deploy without an approved AWS test window.

This runbook prepares one disposable OpsReplay checkpoint in `ap-southeast-1`. Every AWS
command must name the `opsreplay` profile and Region. Stop if the account, resource owner,
image digest, certificate hostname, or approved budget differs from the review record.

## 1. Prepare the parameter record

Copy [the example mapping](../../infra/checkpoint-runtime-parameters.example.json) to an
untracked file. Replace every angle-bracket value from reviewed foundation outputs and
approved resources. Keep `EnableGatewayPath=true` and
`EnableSessionAdmission=false`. Do not store tokens, passwords, private keys, or session
data in the mapping.

Use the same reviewed mapping for `cdk diff` and `cdk deploy`. Convert each entry to an
explicit `--parameters OpsReplaySessionStart:<key>=<value>` argument. Do not use shell
defaults for account, Region, digest, ARN, subnet, security group, origin, or hostname.

## 2. Run read-only preflight checks

Authenticate and record the exact account before any change:

```sh
aws sso login --profile opsreplay
aws sts get-caller-identity --profile opsreplay --region ap-southeast-1
aws cloudformation describe-stacks --stack-name OpsReplayCheckpointFoundation --profile opsreplay --region ap-southeast-1
```

Confirm the approved budget and current service quotas. Do not infer capacity from local
tests or default AWS documentation.

```sh
aws budgets describe-budgets --account-id <confirmed-account-id> --profile opsreplay --region us-east-1
aws service-quotas list-service-quotas --service-code lambda --profile opsreplay --region ap-southeast-1
aws service-quotas list-service-quotas --service-code fargate --profile opsreplay --region ap-southeast-1
aws service-quotas list-service-quotas --service-code elasticloadbalancing --profile opsreplay --region ap-southeast-1
```

Lambda keeps 100 executions unreserved. With the default parameters, this stack reserves
57 executions in runtime-only mode: 4 for reconciliation, 1 for sweep, 4 for owner end,
12 across the three result reads, 4 for recording-work publication, 16 for terminal
tickets, and 16 for session status. Opening admission adds 8 for StartSession, for a total
of 65. The account quota must therefore be at least 157 before runtime activation and 165
before admission, plus reserved concurrency already assigned to other functions in the
Region. If a burst parameter changes, recalculate the requirement as follows:

```text
runtime only = 100 + other reservations + 25 + TerminalTicketBurstLimit + SessionStatusBurstLimit
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

Confirm the candidate task, certificate, identity client, network ownership, and absence
of unintended public routes. The task definition must have no task role and must use the
reviewed digest-only images.

```sh
aws ecs describe-task-definition --task-definition <reference-task-definition-arn> --profile opsreplay --region ap-southeast-1
aws acm describe-certificate --certificate-arn <certificate-arn> --profile opsreplay --region ap-southeast-1
aws cognito-idp describe-user-pool --user-pool-id <user-pool-id> --profile opsreplay --region ap-southeast-1
aws cognito-idp describe-user-pool-client --user-pool-id <user-pool-id> --client-id <public-client-id> --profile opsreplay --region ap-southeast-1
aws ec2 describe-subnets --subnet-ids <public-a> <public-b> <workload-a> <workload-b> --profile opsreplay --region ap-southeast-1
aws ec2 describe-route-tables --filters Name=vpc-id,Values=<vpc-id> --profile opsreplay --region ap-southeast-1
aws ec2 describe-security-groups --group-ids <environment-sg> <endpoint-sg> --profile opsreplay --region ap-southeast-1
```

Build the application bundles, synthesize locally, and inspect a read-only diff. The
`--no-change-set` option avoids creating a temporary CloudFormation change set.

```sh
npm run quality
npm run check
npm run infra:test
npm run infra:synth
npm run infra:cdk -- diff OpsReplaySessionStart --no-change-set --profile opsreplay --region ap-southeast-1 <reviewed-parameter-arguments>
```

Stop if the diff widens IAM, adds public task addresses, enables ExpireProvisioning,
changes retained-resource ownership, or opens admission.

## 3. Prepare the runtime with admission closed

The following is a write operation. Run it only after approval and a final diff review.

```sh
npm run infra:cdk -- deploy OpsReplaySessionStart --profile opsreplay --region ap-southeast-1 <reviewed-parameter-arguments>
```

Verify that StartSession reserved concurrency is zero. Verify the Gateway targets are
healthy and private, the recording publisher and lifecycle triggers are enabled, and
ExpireProvisioning remains at zero. Inspect CloudFormation events, ECS service events,
Lambda configurations, EventBridge rules, the DynamoDB stream mapping, alarms, dead
letters, and logs. Do not create a learner session yet.

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
zero while Gateway, terminal tickets, owner end, reconciliation, sweep, recording, and
result reads remain enabled.

Wait until every approved attempt has a terminal outcome, task stop is confirmed,
recording work is terminal, required finalisation is saved, playback export is complete
or explicitly recorded as unavailable, and no lifecycle or recording work remains.
Inspect alarms, dead-letter queues, the lifecycle and recording indexes, ECS tasks, and
retained table and bucket contents. Do not use reserved concurrency zero as a drain
operation and do not clear locks or records manually.

Only then set `EnableGatewayPath=false`, review the diff, and deploy. Remove disposable
foundation resources only under their separate ownership procedure. The application
table and buckets are retained by policy. Inventory their ongoing cost and obtain
explicit approval before deleting retained data. Record the final account, Region,
stack events, image digests, test results, retained resources, and teardown evidence.

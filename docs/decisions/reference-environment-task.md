# Reference environment task

Date: 12 October 2026

Status: implemented candidate definition with local validation; not published,
deployed, or activated.

## Context

The existing start action saves and launches a pinned task revision, but the
repository lacked the reference two-container definition. The generic Monitor
runtime also deliberately omitted the private Challenge manifest that it requires
at startup. A task blueprint and content publication are separate reviewable changes.

## Decision

Add `OpsReplayReferenceEnvironment` as a separate stack containing only one ECS
task definition. Use the existing `opsreplay-` family convention, Linux/x86_64,
Fargate, and `awsvpc`. Require digest parameters for the same-account, same-Region
Challenge and Monitor ECR repositories. Do not supply guessed digest defaults.

The reference manifest's 1024 CPU units and 2048 MiB are the whole-task budget.
Challenge receives 768 CPU shares and a 1536 MiB memory limit; Monitor receives
256 shares and 512 MiB. Container CPU values are relative shares under contention,
not hard per-container quotas. These are candidate allocations, not measured
capacity or proof that hostile load cannot delay Monitor. Both containers are
essential and use init with a 30-second stop timeout. No service health checks or
restart policy interfere with learner service changes.

Challenge retains root and the capabilities needed for service startup, ownership,
user changes, and process control. Drop `NET_RAW`, `SETPCAP`, `MKNOD`,
`AUDIT_WRITE`, `SETFCAP`, and `SYS_CHROOT`; add none. Monitor runs as UID 1000,
drops all capabilities, and has a read-only root. Do not share PID or IPC
namespaces, use privileged mode, or attach a task role.

Reuse the watched-volume helper unchanged. Challenge initializes and writes the
ephemeral task volume; Monitor mounts it read-only. No credentials or private
manifest live there. Monitor's current bounded state is in process memory, so this
definition does not add the private writable buffer volume considered in the
broader architecture proposal. Loss of that state fails recording closed.

Add a Docker `reference` target containing the private manifest and runtime, but
no test clients or credentials. Keep `runtime` as the default generic target.
The existing start action's Monitor-only S3 environment-file override supplies
the session secret and TLS identity through the execution role. No static secrets
or plaintext overrides are introduced. The execution role and log group remain
owned by the existing stacks.

Order Monitor after Challenge's container `START`, not service health. Local testing
without the harness's listener wait reproduced a false startup failure, so control
now retries false initial-state checks serially with a 30-second readiness deadline,
at most 30 attempts, and up to one second between attempts. A bounded in-flight
check can finish after the deadline but cannot then admit the session. Exceptions
fail immediately; shutdown cancels waits and fences late results. The
initial-state verification and recording readiness transaction still gate access.
Only Monitor's fixed error-code logs go to CloudWatch, in non-blocking mode with a
1 MiB buffer. Learner terminal output is recorded from the existing PTY source,
not from process logs.

## Validation

Synthesis tests assert immutable image parameters, the sole-resource boundary,
authored resource totals, isolation, watched mounts, and existing encrypted
Monitor-only bootstrap compatibility. Real Docker tests consume settings from the
synthesised task, run the reference target with a separate test-client image, and
exercise fault, reload/restart trap, both sustained repairs, captures, authentication,
private files/processes, read-only mounts/root, and startup without a listener wait.

Docker's extra PID limits and `no-new-privileges` are local test restrictions.
Docker shares do not prove Fargate's task-level CPU enforcement. Static assertions
cannot prove IAM or S3 injection; local environment checks cannot prove Fargate
metadata isolation.

## Remaining Gates

The separate publication PR must publish the tested reference target, validate and
bind both image digests, private manifest, and exact task revision into an immutable
content version. The current checkpoint workflow still publishes the generic Monitor
target and cannot provide the required reference digest. Authored content stays draft
with null digests; no admission path is enabled here.

A separately approved disposable AWS checkpoint must verify private launch on
platform 1.4.0, no public IP/internet route/task credentials/ECS Exec, image pulls,
Monitor-only encrypted bootstrap injection, private manifest and PID isolation,
watched-volume initialization, TLS/readiness, both repairs, resource contention,
essential-container failure, recording drain, task stop, and confirmed cleanup.
Record costs and retained resources; remove the exact disposable resources afterward.
Do not treat registering a task revision as launching, publishing, or activating it.

## Rollback

Before activation, reverting this increment removes only the candidate definition,
reference image target, and their checks/docs. It changes no running sessions.
After future deployment, retain any revision/image referenced by an active session;
stop and confirm cleanup before deregistering unused candidate revisions. Never
rewrite a published version to point at a different runtime.

# Recording work publication increment

Status: implemented locally, AWS validation pending
Date: 8 October 2026
Owner: Hao Zhe

## Context

The gateway can record one session, but it cannot discover a task from lifecycle state.
The saved session also lacks the task address and the certificate needed to authenticate
the monitor before sending its bearer secret.

## Decision

The start action creates one self-signed EC P-256 certificate and private key for each
session. The certificate is valid from session creation through the launch-recovery
deadline, admitted session limit, and existing one-minute recording headroom. The
private S3 environment file contains the monitor secret and base64-encoded certificate
and key. Only the public certificate is copied to the private session record. The
private key never enters DynamoDB, ECS API overrides, logs, or source control.

The environment-file write remains conditional. A competing write, conditional
conflict, or uncertain response is resolved by a bounded read of the stored object. The
reader validates the secret, certificate, private key, key match, certificate purpose,
and validity before returning the public certificate. A saved certificate must match
the file on every retry. Definite S3 failures remain failures.

A separate action consumes ECS `RUNNING` task-state events. It accepts one private IPv4
address from the task ENI, strongly reads the session, checks the saved cluster and task
identity, and rejects expired or terminal provisioning work. One conditional DynamoDB
write stores the task ARN and address and adds these top-level sparse-index keys:

```text
WorkPK = RECORDING
WorkSK = <session-created-at>#SESSION#<session-id>
```

The work index is `unfinished-work`. It uses a keys-only projection. Its query is only a
discovery hint because global secondary indexes are eventually consistent. The gateway
must strongly read the session before it uses the address, certificate, or secret.
Terminal work remains discoverable until the gateway work-source adapter retires it.
That adapter and the index deployment are in the next stacked changes.

## Failure and recovery

Concurrent start calls can generate different candidate key pairs, but S3 accepts only
one object. Every losing caller reads that object and saves its certificate. A lost S3
or DynamoDB response is accepted only after a read proves that the complete expected
state exists. Duplicate task events write the same address and work key. A changed task
ARN, changed address, cluster mismatch, invalid certificate, malformed event, or
ambiguous ENI address fails closed.

The task-state action does not mark a session ready. Readiness still requires a healthy
monitor and an initialized recorder lease. The action does not run a recorder or deploy
the gateway.

## Validation

Local tests cover certificate purpose, validity and key matching, immutable bootstrap
writes, competing and uncertain S3 outcomes, bounded reads, concurrent publication,
identity conflicts, expired and terminal sessions, uncertain DynamoDB responses, event
validation, and bundled-handler loading. DynamoDB Local verifies the atomic session and
work-key update. These tests do not prove EventBridge delivery, Fargate event contents,
IAM, S3, DynamoDB global secondary index behavior, or private network connectivity.

# Security and data handling

No OpsReplay runtime is deployed. Both disposable AWS checkpoints were removed after
validation. Retained DynamoDB tables, S3 buckets, and Cognito user pools remain and can
contain checkpoint session or identity data. The selected retained resources are owned
by `OpsReplayDurableResources`. The session table and learner user pool have
service-level deletion protection enabled. The CDK bootstrap stacks in
`ap-southeast-1` and `us-east-1` and the account-level GitHub OIDC provider also remain,
but they do not run the application.
Before the pilot, verify the controls in
[architecture](docs/architecture.md), [Challenge environments](docs/challenges.md),
[data model](docs/data-model.md), and [LLM integration](docs/llm.md).

- Never commit tokens, account credentials, private keys, real incident logs, or learner
  data. Use local ignored configuration and deployment secret storage.
- Learners get root shells by design. Environment tasks must have no task IAM role, no
  internet route, inbound traffic only from the gateway, and CPU, memory, and time caps.
  Isolation tests must pass before any external user.
- Containers in one task share a network namespace. Protect gateway-to-monitor traffic
  with authenticated TLS and verified task identity. A plaintext secret is insufficient.
  Drop `NET_RAW` and unnecessary capabilities. Do not share the monitor's PID namespace,
  secrets, or writable storage with the challenge container. Bound control requests and
  watched-file reads. Never follow links or read non-regular files from shared paths.
- Terminal tickets are short-lived, single-use, stored only as hashes, and never placed
  in URLs or logs.
- Public source code can reveal authored solutions. Runtime controls support learning,
  but this is not an exam or hiring assessment platform.
- Validate ownership, entitlement, request identity, and bounds server-side. Treat user
  input, terminal output, and log content as untrusted, including in prompts.
- Recordings contain everything a learner typed or printed. Keep them private and never
  put them in application logs. Obtain informed consent before a recorded external pilot
  session. Live recording pages expire after seven days and sealed recordings after 30
  days. Readers enforce the authoritative recording retention boundary before they
  follow S3 references. The evaluation owner handles deletion requests only after the
  session is terminal and recording work is finished. The complete deletion path removes
  the session prefix, DynamoDB session partition, and matching start receipt as defined in the
  [recording retention decision](docs/decisions/recording-retention.md).

If you find an exposed credential, an isolation gap, or an access-control issue, contact
the project owner privately through the team's agreed channel. Do not post secrets or
learner data in a public issue. Revoke exposed credentials before cleaning Git history.

## Current npm dependency findings

As checked on 26 October 2026, the lockfile resolves Ajv's `fast-uri` dependency to
`3.1.9`. This compatible patch fixes the URI-normalization and scheme/host findings
reported for `3.1.8`:
[GHSA-w74x-v6f9-j3xg](https://github.com/advisories/GHSA-w74x-v6f9-j3xg) and
[GHSA-333x-w4r6-6crp](https://github.com/advisories/GHSA-333x-w4r6-6crp).
`npm audit --omit=dev` reports no known findings. The production audit remains a CI gate.

The development dependency fixes are also available. CDK `2.274.0` bundles
`brace-expansion` `5.0.12`, replacing the affected `5.0.9` in CDK `2.272.0`.
The development-only Swagger parser resolves compatible `undici` `8.12.3`, replacing
affected `8.10.2`. These address the previously reported brace-expansion recursion
and undici content-encoding findings:
[GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7) and
[GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c), plus the
related advisories. The full npm audit reports no known findings for this lockfile.

This audit result is a dated dependency check, not proof of application security or
an image-scan result. Recheck before deployment. Do not patch `node_modules`, hide
findings, pass untrusted remote documents to contract tools, or process untrusted
file patterns through CDK.

## Checkpoint image findings

The [minimal Node runtime change](docs/decisions/minimal-node-runtime.md) removes
unused util-linux and system-zlib packages from Gateway and Monitor candidates.
Node's version and UID/GID remain unchanged. The final local OS scans report zero
HIGH/CRITICAL/UNKNOWN for the Gateway and both Monitor targets, with 21 MEDIUM and
11 LOW findings in each. No remaining finding has a listed fixed version in this
scan. Current CA/timezone payloads and matching records replace the older files
that introduced three UNKNOWN advisories in the earlier candidate. The metadata
remains available to scanners.
These local results are not new ECR scans or production clearance. The Challenge
image is unchanged and its reported findings remain open.

### 29 October checkpoint and initial triage

The [29 October AWS checkpoint](docs/checkpoints/2026-10-29-saas-aws.md) scanned six
exact published images. Each Gateway and Monitor image had seven HIGH findings;
each Challenge image had 27. No CRITICAL finding was reported in those scans.
The explicit exception covered only two controlled attempts and those exact images.
It has ended and does not approve another test window, external pilot or production.
Temporary repositories and images were removed after the run.

The initial fresh local build on 29 October still resolved the same reported HIGH-package
versions. The Dockerfiles already apply available Bookworm updates. Vim Tiny omits
several affected features and plugins, and the Challenge has no DIGEST-MD5 plugin.
These facts do not clear the entire source-package finding set. Swap recovery remains
an open Vim concern. The zlib affected-range discrepancy also remains open. See the
checkpoint for exact versions and source references.

The [31 October editor recovery backport](docs/decisions/editor-recovery-backport.md)
covers only `CVE-2026-28421` and passed hosted editor and service compatibility
checks. It preserves the Tiny editor, Nano default and package provenance. Other
Vim findings and fresh exact-digest scan or ECR clearance remain pending.

Before another runtime campaign, inspect fresh scans of its exact image digests,
apply available fixes, and record unresolved findings. Any new temporary exception
needs explicit owner approval for its targets and window. Do not suppress findings,
remove supported investigation tools just to reduce counts, or treat isolation as
proof that every finding is harmless. The local builds are not new ECR scan results.

### Historical 10 October findings

The first ECR scan on 10 October 2026 reported six critical findings in each Node runtime
image. Five were attributed to the Debian Perl source package at
`5.36.0-7+deb12u3`. One was GnuTLS `CVE-2026-95210` at `3.7.9-2+deb12u7`. The Challenge
image reported the same GnuTLS finding.

The checkpoint images now build from refreshed immutable base-image digests and apply
available Debian Bookworm package updates. Tests require `perl-base`
`5.36.0-7+deb12u4` or later in the gateway and Monitor runtime images. This does not
prove that every Perl finding is fixed. Debian currently postpones at least
`CVE-2026-12087`, and no Bookworm fix is available for `CVE-2026-95210`.

Publish the refreshed images and inspect their new ECR scans before another AWS runtime
test. Do not treat the package-floor tests or a successful local image build as evidence
that the registry findings are resolved.

# Security and data handling

No OpsReplay runtime is deployed. The first disposable AWS checkpoint was removed after
validation. The standard CDK bootstrap stack and account-level GitHub OIDC provider
remain, but they do not run the application. Before the pilot, verify the controls in
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

## Current npm dependency finding

As checked on 5 October 2026, CDK `2.272.0` bundles `brace-expansion` `5.0.9`. The full npm audit
reports a high-severity denial-of-service finding in this development dependency:
[GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7). It also reports
related brace-expansion advisories. The package is used by CDK file-pattern handling,
not included in the Lambda bundle. `npm audit --omit=dev` reports no known findings.

The current CDK release bundles the affected package. `npm audit fix` and a nested npm
override do not replace it. Do not patch `node_modules`, hide the finding, or process
untrusted file patterns through CDK. Recheck for a fixed CDK release before the next AWS
deployment that uses CDK application assets.

## Checkpoint image findings

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

# Security and data handling

Nothing is deployed yet. Before the pilot, verify the controls in
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
- Recordings contain everything a learner typed or printed. Keep them private, never in
  application logs, and agree consent and retention before the external pilot. Provide
  an owner process for deleting a learner's data and recordings.

If you find an exposed credential, an isolation gap, or an access-control issue, contact
the project owner privately through the team's agreed channel. Do not post secrets or
learner data in a public issue. Revoke exposed credentials before cleaning Git history.

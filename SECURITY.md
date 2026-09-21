# Security and data handling

The application is not deployed yet. Before the pilot, verify the controls in
[architecture](docs/architecture.md), [data model](docs/data-model.md), and
[LLM integration](docs/llm.md).

- Never commit tokens, account credentials, private keys, real incident logs, or
  learner data. Use local ignored configuration and deployment secret storage.
- Public source code can reveal authored solutions. Runtime evidence controls
  support learning, but do not make this an exam or hiring assessment platform.
- Validate ownership, entitlement, command arguments, current version, and action
  prerequisites server-side. Treat user input and retrieved content as untrusted.
- Do not put hidden scenario data, raw prompts, or free-text submissions into
  application logs. Record only the metadata needed for debugging and evaluation.
- Agree consent and retention before the external pilot. Provide an owner process
  for deleting learner data and related replay sessions.

If you find an exposed credential or access-control issue, contact the project
owner privately through the team's agreed channel. Do not post secrets or learner
data in a public issue. Revoke exposed credentials before cleaning Git history.

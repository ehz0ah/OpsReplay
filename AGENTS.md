# Instructions for coding agents

Read [README.md](README.md), [docs/PRD.md](docs/PRD.md), and the relevant contract
before changing code. Use [docs/decisions/README.md](docs/decisions/README.md) to
distinguish product decisions from proposed technical choices.

- Implement a bounded task. Do not add product modes or services without a need.
- Use one deployed Lambda per action. Keep its handler, bundle, IAM role, timeout,
  and concurrency limit separate. No multi-route server inside a Lambda.
- Lambda functions must not invoke other Lambda functions. Reuse ordinary code
  modules. Introduce event-driven coordination only for a concrete requirement.
- Keep handlers stateless. Reuse SDK clients, not learner data. Bound requests,
  retries, and execution time. Use atomic writes and saved request receipts.
- Give each function only the permissions its action needs. Validate identity and
  input before effects, and keep private data out of responses and logs.
- Test failure paths and concurrency, not only success. Validate cloud behaviour on
  AWS before claiming it works there. Do not replace tests with assumptions.
- Keep Challenge manifests, validators, probes, traps, unreleased hints, and review
  findings out of browser payloads, errors, logs, and prompts.
- Environment tasks have no task IAM role and no internet route. Only the gateway
  reaches them. Do not weaken this for convenience.
- The monitor treats watched files as untrusted and authenticates the gateway.
- Every mutation checks ownership, entitlement, and request identity. Start and end
  never launch a second task or record a result twice.
- Retries never change a first attempt or its score.
- The assistant never runs a command without learner confirmation and never scores.
- Do not fake environment behaviour with scripted output or LLM-generated results.
- Do not describe planned modules as implemented or checked locally as deployed.
- If a contract changes, update its examples, documentation, and checks together.
- Run `npm run check`. Run relevant application and scenario tests once they exist.
  Report exactly what was tested and what remains unverified.
- Do not copy competitor content, course PDFs, credentials, or unlicensed assets.
- Never add credentials to code, logs, examples, images, or commits.
- Do not add AI co-author trailers to commits. Report-writing AI disclosure belongs in
  the course report. Do not remove or falsify that disclosure.
- Do not spawn subagents unless the user explicitly asks for delegation.
- Use concise technical English. Avoid em dashes and unsupported claims.

Document routine technical decisions in the decision register. Escalate changes to
product scope to the team. Preserve unrelated work by other contributors.

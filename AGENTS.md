# Instructions for coding agents

Read [README.md](README.md), [docs/PRD.md](docs/PRD.md), and the relevant contract
before changing code. Use [docs/decisions/README.md](docs/decisions/README.md) to
distinguish agreed scope from proposed technical choices.

- Implement a bounded task. Do not add product modes or services without a need.
- Preserve the deterministic engine and shared direct/LLM tool contract.
- Keep private state and unrevealed evidence out of browser payloads and prompts.
- Every mutation checks ownership, request identity, and session version.
- Preserve first-attempt records when creating a replay.
- Browser waiting, rendering, and LLM latency never advance simulated time.
- Do not use arbitrary code evaluation in authored scenario definitions.
- Do not describe planned modules as implemented or checked locally as deployed.
- If a contract changes, update its examples, documentation, and checks together.
- Run `npm run check`. Run relevant application tests once they exist. Report
  exactly what was tested and what remains unverified.
- Do not copy competitor content, course PDFs, credentials, or unlicensed assets.
- Never add credentials to code, logs, examples, or commits.
- Do not add AI co-author trailers to commits. Report-writing AI disclosure belongs
  in the course report. Do not remove or falsify that disclosure.
- Do not spawn subagents unless the user explicitly asks for delegation.
- Use concise technical English. Avoid em dashes and unsupported claims.

Document routine technical decisions in the decision register. Escalate changes
to agreed product scope to the team. Do not treat every implementation detail as
requiring approval. Preserve unrelated work by other contributors.

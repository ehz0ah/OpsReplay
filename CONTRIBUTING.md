# Contributing

## Before starting

Read the [PRD](docs/PRD.md), [decision register](docs/decisions/README.md), and the
contract for the module you will change. Choose one work package from the
[implementation plan](docs/implementation-plan.md). Record an owner and intended
files in an issue or the team's task board before overlapping work begins.

The report is under review. Detailed technical proposals are working defaults,
not evidence that every teammate has approved them. Raise conflicting requirements
early and record the outcome.

## Local checks

```sh
npm ci
npm run check
```

Use your own Git identity. Keep personal and work credentials separate. This
repository must not contain `.env` files, tokens, provider responses with personal
data, or cloud state. Use unprivileged development credentials when cloud tests
are introduced. There are no deployable resources in this baseline.

## Pull requests

1. Branch from `main`, using a short name such as `feat/session-store`.
2. Keep changes focused. Update affected contracts before depending on them.
3. Include behaviour, rationale, verification, and known limits in the PR.
4. Request review from another team member. Reviewers check correctness, scope,
   state visibility, and failure handling as applicable.
5. Merge after review and successful checks. Branch protection must be enabled
   separately in GitHub settings. It is not configured by adding this document.

Use clear commits such as `docs: define checkpoint replay semantics`. Do not add
generated binaries, dependency directories, or AI co-author trailers. The report
PDF is intentionally tracked as a small review snapshot.

## Contract and content changes

- Product changes update the PRD and decision register.
- API changes update OpenAPI and examples, with compatibility notes.
- Scenario changes produce a new immutable content version after publication.
- Engine changes preserve old replay behaviour or introduce a new engine version.
- A metric or action formula needs an example trace that demonstrates its effect.
- A published exercise needs source attribution and an independent team review.

Use tests for meaningful behaviour: ordering, retries, hidden evidence, state
transitions, and content consistency. Do not add tests that merely restate a type
definition. Existing repository checks are the baseline, not a substitute for
future engine, API, UI, and cloud integration tests.

## Completion criteria

A task is complete when its acceptance criteria pass, its documentation is
current, error paths are handled, and evidence of validation appears in the PR.
Do not claim AWS validation from local tests. Do not claim learning effectiveness
from a working interface.

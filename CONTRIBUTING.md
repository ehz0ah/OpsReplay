# Contributing

## Before starting

Read the [PRD](docs/PRD.md), [decision register](docs/decisions/README.md), and the
contract for the module you will change. Choose one work package from the
[implementation plan](docs/implementation-plan.md). Record an owner and intended
files in an issue or the team's task board before overlapping work begins.

The preliminary report, version 5, defines the product direction. The decision register
and domain contracts record later refinements. Detailed technical proposals
are working defaults, not evidence that every teammate has approved them. Raise conflicting requirements
early and record the outcome.

## Local checks

```sh
npm ci
npm run quality
npm run check
```

Use your own Git identity. Keep personal and work credentials separate. This
repository must not contain `.env` files, tokens, provider responses with personal
data, or cloud state. Use unprivileged development credentials when cloud tests
are introduced. Challenge image and gateway work will need local Docker. There are no
cloud resources deployed by this baseline.

## Pull requests

1. Branch from `main`, using a short name such as `feat/session-store`.
2. Use `type(scope): imperative summary` for the PR title. The scope is optional.
   Supported types are `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`,
   `build`, `perf`, and `revert`.
3. Keep changes focused. Update affected contracts before depending on them.
4. Include behaviour, rationale, verification, known limits, risk, and rollback in the PR.
5. Request review from another team member. Reviewers check correctness, scope,
   state visibility, and failure handling as applicable.
6. Merge after review and successful checks. Branch protection must be enabled
   separately in GitHub settings. It is not configured by adding this document.

Use clear commits such as `docs: define session playback semantics`. Do not add
generated binaries, dependency directories, or AI co-author trailers. The report
PDF is intentionally tracked as a small review snapshot.

## Contract and content changes

- Product changes update the PRD and decision register.
- API changes update OpenAPI and examples, with compatibility notes.
- Challenge image, monitor, or manifest changes produce a new immutable Challenge
  version with pinned digests after publication.
- A Challenge change needs scenario harness evidence: fault at start, reference fix,
  and each trap.
- Gateway protocol changes update the public schemas, examples, and `docs/api.md`.
- A published exercise needs source attribution and an independent team review.

Use tests for meaningful behaviour: ordering, retries, hidden evidence, state
transitions, isolation, and content consistency. Do not add tests that merely restate
a type definition. Existing repository checks are the baseline, not a substitute for
future image, monitor, gateway, API, UI, and cloud integration tests.

## Completion criteria

A task is complete when its acceptance criteria pass, its documentation is
current, error paths are handled, and evidence of validation appears in the PR.
Do not claim AWS validation from local tests. Do not claim learning effectiveness
from a working interface.

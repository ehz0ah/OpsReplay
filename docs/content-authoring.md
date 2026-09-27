# Content authoring

Status: manual authoring workflow. There is no content-generation or authoring UI.

## Source and ownership

Use official engineering incident reports for inspiration. Write original service names,
configuration, logs, code, and explanations. Link to the original source and record which
failure mechanism was adapted. Public availability does not imply permission to copy
text, figures, or code. Keep third-party notices when licensed material is deliberately
reused after review.

The three current Challenges and the review bundle are synthetic drafts. They have no
claimed incident source and cannot be published as historically sourced content.

## Challenges

A Challenge is a versioned container image plus a
[manifest](../packages/contracts/schemas/challenge.schema.json). See the
[draft manifests](../content/challenges/README.md) and the
[runtime contract](challenges.md).

The image contains a small service stack, such as nginx, a web application, PostgreSQL,
and CoreDNS, under a process supervisor, with exactly one planted misconfiguration. It
also provides:

- `service <name> start|stop|restart|reload` wrappers over the supervisor;
- shell integration markers for command recording;
- every tool the Challenge needs, installed at build time, because environments have no
  internet access;
- logs written to the files listed in the manifest.

Fargate constraints apply: no privileged mode, no nested Docker, and no added Linux
capabilities beyond `SYS_PTRACE`. Loopback addresses such as `127.0.0.2` can stand in for
separate hosts. Image size affects start-up time, so measure it.

The manifest declares services and watched files, traffic journeys, dashboard metrics,
the alert, validators, health probes, the planted fault, the reference fix, traps, hints,
and the debrief.

- The alert and probe labels describe symptoms, never the cause.
- Validators exercise end-to-end behaviour, such as a complete checkout, so a spoofed
  response is less likely to pass.
- Each trap from the Challenge's "why action order matters" has scripted commands, the
  probe it breaks, command patterns for the debrief, and, where one exists, a safe
  alternative.
- Command patterns are case-sensitive JavaScript regular expressions. Make them specific
  enough not to match the reference fix or the safe alternative.
- Evidence rules also need output patterns. All must match one saved command excerpt.
  Use narrow descriptions that the output can support. Split evidence across separate
  items when it needs output from different commands. Include a valid output example,
  a failed read, and unrelated output in the reference checks. Timing rules for traps
  identify possible harmful actions, not proven causes.
- Hints are ordered and released no earlier than their delay after readiness.

## Evidence quality

Evidence should support diagnosis without stating the answer. Include realistic noise
only when it teaches prioritisation. Logs, configuration, metrics, and the debrief must
describe the same failure mechanism. A temporary mitigation can reduce impact even if
recovery is incomplete. Document it in the debrief.

## Publication checks

1. `npm run check` passes: schema, references, trap patterns, and bounds.
2. The scenario harness confirms the fault at start, the reference fix, each trap, and
   each safe alternative, over 20 repeats.
3. Playback of the reference run matches its recorded output, logs, and metrics.
4. Isolation tests pass for the image on Fargate.
5. Browser-visible output and assistant context contain no private manifest data.
6. Another team member reviews realism, evidence, difficulty, tier, and debrief.
7. Publish a new immutable version with pinned image digests. Existing sessions keep
   their old version.

## Learn

A Learn entry is Markdown with metadata: title, category, access plan, summary,
lessons, official source links, and related exercises. A build step renders free
entries as static pages for CloudFront and puts Pro entries in private S3, where the API
returns them after an entitlement check. The build sanitises HTML and fails on missing
metadata or broken related-exercise IDs.

## Code Review

A Code Review exercise is a [bundle](../packages/contracts/schemas/review.schema.json)
with a diff, context, language, tier, plan, and reference findings with line ranges and
explanations. Each finding must cover lines that exist on its side of the diff. Some
diffs introduce faults that later appear in Challenges. Link them with
`relatedChallenges`. Do not add a language option without published content.

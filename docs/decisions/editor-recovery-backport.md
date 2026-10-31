# Debian editor recovery backport

Date: 31 October 2026
Status: source candidate; hosted build and compatibility checks pending.

The Challenge keeps Debian Bookworm, Vim Tiny, its existing aliases and Nano as
the default editor. Bookworm still publishes Vim Tiny `2:9.0.1378-2+deb12u2`;
the Bookworm backports package page reports no Vim Tiny package. A package-list
refresh does not provide the required recovery fix.

Apply the upstream recovery checks from Vim commit
`65c1a143c331c886dc28888dd632708f953b4eb3` to the exact current Debian source.
The local adaptation uses subtraction to check the page extent without signed
addition overflow and rejects block zero. Build with Debian's Tiny configuration
and hardening rules. Do not enable the full Vim feature set or change the image's
service packages, filesystem layout, entrypoint, environment or task permissions.

The builder retrieves source through signed Debian APT indexes and fails if the
installed Vim version changes. The patch must apply with no fuzz. Rebuild only
the Vim Tiny package and install it in the existing Challenge runtime. Build tools
and source remain in separate stages. The runtime records the local suffix
`+opsreplay1`, local origin, upstream patch, original version, licence and binary
hash. Package file hashes are recomputed. This is a local backport, not a claim
that Debian published a fixed package.

The DNS image derives from the same Challenge base. Both image suites check `vi`,
`vim` and `vim.tiny` editing, Unicode text, genuine swap recovery created by a
normal edit, default Nano availability and package hashes. The checks run inside
an isolated temporary container and contain no malformed samples. A nonzero
exit, timeout, missing binary or cleanup failure cannot count as a pass.

CI gives the three jobs that build the Challenge 20 minutes. The earlier preserved
source build took about four minutes before runtime assembly and scenario tests;
the former ten-minute jobs did not allow that build plus the full monitor suite.
The editor test has a 45-second bound. Always-run CI cleanup targets its own
container label. Production allocations and deadlines do not change.

## Verification and remaining gates

Static patch application, syntax and repository checks are separate from hosted
image compilation and real service tests. No editor process, Docker image build,
malformed-input test, registry scan or AWS activation is run on the work Mac.

Compatibility and the upstream source checks do not prove complete image security.
The existing util-linux, system-zlib, other Vim and SASL findings require fresh
exact-digest review. Do not erase package metadata, declare all findings fixed,
reuse the expired two-attempt exception or treat local source validation as ECR
clearance. New images must pass the existing publication and deployment-binding
process before learner admission. Existing sessions keep their saved image pins.

Revert this candidate and its image tests to restore the distribution editor.
No user-data migration is required. Preserve images referenced by existing sessions.

Sources:

- https://github.com/vim/vim/commit/65c1a143c331c886dc28888dd632708f953b4eb3
- https://packages.debian.org/bookworm/vim-tiny
- https://packages.debian.org/bookworm-backports/vim-tiny

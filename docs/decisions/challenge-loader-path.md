# Challenge loader pathname backport

The historical 31 October scan reports `CVE-2026-86805` (MEDIUM) and
`CVE-2026-95818` (LOW) against Bookworm glibc. Debian lists both as fixed in its
newer source; its tracker identifies upstream commit
`ed0c137b97eb940b4b64981e84ed806d3276edd9` as the fix. That commit has an upstream
review. Bookworm's native source still has the affected loader path check.

Backport only the production changes to `elf/dl-load.c` and the exact upstream
`elf/dl-path-normalize.h`. Terminate the expanded path before inspection, normalize
it in place and check the normalized path against trusted directory boundaries.
The loader then opens the same path it checked. This also removes the old stack
allocation used to check a separate normalized copy. Ordinary non-secure loader
paths retain their existing behaviour.

Use the existing exact Bookworm build, paired libc/loader, version guard, ABI
checks and provenance retention. Apply both local patches with zero fuzz after
Debian's architecture patches. The resulting local libc6 version is
`2.36-9+deb12u14+opsreplay2`. Retain the loader patch in package documentation and
record its reviewed upstream commit. No dependency, service or product change
is required.

Hosted checks compile the upstream normalization helper with ordinary path cases
and a buffer boundary check. Both full Challenge suites must verify package
hashes, normal loader and utility operations, editor recovery, service behaviour,
reference fixes and traps. Upstream privilege/race fixtures are excluded. These
ordinary checks do not claim to reproduce the vulnerabilities. No native test
runs on the work Mac. Fresh exact-digest scans and source review remain required
before admission.

`CVE-2026-97399` affects the Power8-specific strncasecmp implementation. The
Challenge publication targets linux/amd64, so that code is not included. Keep
the scanner record for qualification; do not add an irrelevant Power8 patch or
claim that every glibc issue is fixed. The separate pending gettext proposal
retains its existing limits.

Sources:

- https://security-tracker.debian.org/tracker/CVE-2026-86805
- https://security-tracker.debian.org/tracker/CVE-2026-95818
- https://security-tracker.debian.org/tracker/CVE-2026-97399
- https://sourceware.org/git/?p=glibc.git;a=commit;h=ed0c137b97eb940b4b64981e84ed806d3276edd9
- https://github.com/bminor/glibc/commit/ed0c137b97eb940b4b64981e84ed806d3276edd9

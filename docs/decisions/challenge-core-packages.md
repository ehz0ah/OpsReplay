# Challenge utility rebuild and native libc

The 31 October exact-digest ECR scans report six HIGH util-linux findings and one
HIGH glibc finding. The image applies available Bookworm updates, which do not
provide fixes for this set.

## Utilities

Build Debian's `2.42.4-1` util-linux source using the signed
`20261031T000000Z` archive and Bookworm build dependencies. Debian lists the
targeted utility issues as fixed in this release or an earlier release. Check
both source archive hashes. Preserve the eight existing packages: bsdutils,
util-linux, util-linux-extra, mount, libblkid1, libmount1, libsmartcols1 and
libuuid1. Keep the bsdutils epoch, Bookworm paths, permissions, PAM configuration
and other non-ELF files. A missing replacement fails the build. Do not add
libfdisk1 when it is not part of the existing runtime package set.

Regenerate Autotools files with Bookworm's tools as in Debian's build recipe;
the release's generated files otherwise request a newer Automake executable.
Use Bookworm's build options where they affect existing tools. Check that the
rebuilt libraries retain their original versioned symbols. Compute ELF runtime
dependencies with `dpkg-shlibdeps`; retain existing package dependencies and add
the computed requirements. Refresh library symbol metadata against each retained
Bookworm package's ABI inventory. Record the actual
local versions, source descriptor, licences, recipes and full package hashes.

## Native libc and scoped risk acceptance

Keep Debian's native libc6, loader and companion libraries. Runtime installation
continues to apply live Bookworm updates. Do not rebuild libc locally, install a
custom libc package or guard the runtime to one original libc6 version. This
avoids a private-ABI pairing risk and lets later Bookworm fixes apply normally.

On 1 November 2026, the maintainer
[recorded the owner's decision](https://github.com/ehz0ah/OpsReplay/pull/135#issuecomment-6553187929)
to drop the glibc backports and accept `CVE-2026-84243`, `CVE-2026-86805` and
`CVE-2026-95818` for the current Challenge deployment. The learner shell already
runs as uid 0 inside an isolated task. SUID/AT_SECURE privilege changes within
that container do not give that learner additional access. The authored shop
service does not assign request data to LANGUAGE. This reasoning is scoped to
this deployment; it is not proof that these vulnerabilities cannot affect other
applications or deployment models.

Debian has no Bookworm fix for these findings. The gettext proposal is not a
released fix. The owner chose the distribution libc over a local core-library
backport. This is a new owner-approved risk acceptance, recorded in
[SECURITY.md](../../SECURITY.md), not reuse of the expired two-attempt exception.
Revisit it when Debian ships a fix, or if a non-root learner, meaningful setuid
boundary, request-controlled locale environment or isolation change is proposed.

## Qualification

Both Challenge suites must check normal utility operations, rebuilt ELF
dependencies, package hashes, editor recovery and existing service behaviour.
Monitor, Gateway, reference fixes, traps, root identity and isolation remain
required checks. Native image checks run on hosted CI, not the work Mac.

Fresh exact-digest ECR clearance remains pending after merge and publication.
Map any reported accepted finding to those exact Challenge digests and confirm
the acceptance's deployment conditions. All other findings need their own review.
Do not suppress findings or reuse the expired exception. Existing attempts keep
their original pins. Compatibility checks and this acceptance alone do not open
admission or establish production readiness.

Sources:

- https://security-tracker.debian.org/tracker/CVE-2026-78408
- https://security-tracker.debian.org/tracker/CVE-2026-78409
- https://security-tracker.debian.org/tracker/CVE-2026-78410
- https://security-tracker.debian.org/tracker/CVE-2026-84243
- https://mirrors.edge.kernel.org/pub/linux/utils/util-linux/v2.42/
- https://sources.debian.org/src/util-linux/2.38.1-5%2Bdeb12u3/debian/rules/
- https://security-tracker.debian.org/tracker/CVE-2026-86805
- https://security-tracker.debian.org/tracker/CVE-2026-95818

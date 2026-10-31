# Challenge utility and libc rebuilds

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

## Libc

Debian still marks `CVE-2026-84243` as unfixed, including its latest glibc source.
Avinal Kumar's v7 proposal for BZ 17142 is under review. It is not a released GNU
or Debian fix. Backport only its production LANGUAGE lookup restriction to the
exact Bookworm `2.36-9+deb12u14` source: reject entries containing a directory
separator and the bare parent-directory entry for ordinary programs too.

Apply Debian's architecture patches before the local zero-fuzz patch. Use Debian's
native amd64 `build_libc` configuration. Replace libc.so.6 and its matching loader
in the original libc6 package after checking their versioned symbol sets. Other
libc6 files remain from that same Bookworm source version. Retain the proposal,
source descriptor, licence, recipe and complete package checksums. The local
version is `2.36-9+deb12u14+opsreplay1`, with an explicit local origin.

This restriction changes LANGUAGE path lookup. The build checks ordinary valid
catalogue translation, rejection of benign path entries and a valid language
fallback. It does not use malformed catalogues or format-string payloads.
The native build and all library, editor and service tests run on hosted CI.
No local Docker or native-library test runs on the work Mac.

## Qualification

Both Challenge suites must check normal utility operations, all rebuilt ELF
dependencies, package hashes, libc loading, Unicode locales and existing service
behaviour. Monitor, Gateway, reference fixes and traps remain required checks.
These checks do not replace the full upstream glibc regression suite and do not
prove scanner clearance. The ECR scanner may still report the local libc
backport. Admission stays closed until fresh exact-digest scans and source-backed
review resolve the whole image gate. Do not suppress a finding or reuse the
expired two-attempt exception. Existing attempts retain their original pins.

Sources:

- https://security-tracker.debian.org/tracker/CVE-2026-78408
- https://security-tracker.debian.org/tracker/CVE-2026-78409
- https://security-tracker.debian.org/tracker/CVE-2026-78410
- https://security-tracker.debian.org/tracker/CVE-2026-84243
- https://mirrors.edge.kernel.org/pub/linux/utils/util-linux/v2.42/
- https://sources.debian.org/src/util-linux/2.38.1-5%2Bdeb12u3/debian/rules/
- https://sources.debian.org/src/glibc/2.36-9%2Bdeb12u14/debian/rules.d/build.mk/
- https://inbox.sourceware.org/libc-alpha/20261012112453.47383-1-avinal.xlvii@gmail.com/

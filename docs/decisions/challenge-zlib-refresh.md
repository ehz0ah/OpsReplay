# Challenge zlib refresh

The 31 October exact-digest ECR scan flags Bookworm's zlib source against
`CVE-2026-85091`. The upstream advisory describes a narrower affected range than
Debian's tracker. Do not waive the finding based only on that difference.

Build Debian's fixed `1:1.3.dfsg+really1.3.2-4` source on Bookworm. Signed source
indexes and both archive SHA-256 checks bind the upstream source and Debian
patches. Require the non-blocking gzwrite patch in the applied patch inventory.
The build uses Bookworm compiler and library dependencies and retains `libz.so.1`.
Disable the optional CRC vector instructions as in Debian's build recipe.

Replace only zlib1g with the locally rebuilt package. Preserve its runtime path,
dependency metadata, source descriptor, licence, applied patch, recipe and full
file checksum inventory. Record its actual local version and origin. This is
not an official Bookworm package.

Hosted checks must pass the upstream ordinary compression tests, Python zlib
and gzip round trips, a normal write through the shared library, package hash
verification and both Challenge/Monitor suites. No local build or library test
runs on the work Mac. Fresh exact-digest scans remain required after merge and
publication; other package findings remain open.

Sources:

- https://security-tracker.debian.org/tracker/CVE-2026-85091
- https://deb.debian.org/debian/pool/main/z/zlib/zlib_1.3.dfsg+really1.3.2-4.dsc
- https://sources.debian.org/src/zlib/1%3A1.3.dfsg%2Breally1.3.2-4/
- https://github.com/madler/zlib/commit/df84af25dc1942490e1d1c899a07619152a46148

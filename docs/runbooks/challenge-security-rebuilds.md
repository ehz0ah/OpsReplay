# Challenge security rebuilds

The Challenge build stages use Debian's `20261031T000000Z` archives. Bookworm,
Bookworm updates and Bookworm security supply binary dependencies and the exact
original packages used by the rebuild recipes. Sid supplies source packages only.
The shared build stage replaces the base image's live package index before any
installation. Each `apt-get download` therefore uses the same frozen Bookworm
index as its version guard.

The initial CA installation uses signed archive indexes over HTTP. Subsequent
archive access uses HTTPS. `check-valid-until=no` applies only to the archived
entries, whose Release dates will expire. Debian signatures and source archive
SHA-256 checks remain required. Do not add `trusted=yes`, disable signature
verification, or configure a sid binary repository.

Runtime installation uses the base image's live Bookworm repositories and applies
available updates. Only the build stages are frozen. The fixed archives are not
proof of image security, and existing attempts retain their original image pins.

## Refresh a rebuild

1. Verify the upstream fix and Debian source descriptor. Select an archive time
   that contains the chosen source versions and required original binary packages.
2. Update the shared build archive URLs in the Dockerfile together. Update source
   versions and SHA-256 pins when changing source. Keep both upstream and Debian
   patch archive checks for zlib, util-linux and glibc.
3. Check the original Bookworm versions in all build recipes. Review their
   control data, dependencies, matched packages and file paths before changing a
   version guard. A missing version must fail the build.
   Preserve the bsdutils epoch and the existing util-linux-extra tools. Compute
   rebuilt ELF dependencies and check original library symbols. For glibc, review
   the [local backport limits](../decisions/challenge-core-packages.md), apply
   Debian architecture patches first and retain the matching native loader.
   Refresh glibc when its runtime version guard detects a newer Bookworm update;
   do not remove the guard to install an older libc over that update.
   Preserve the [loader pathname backport](../decisions/challenge-loader-path.md)
   and check its production adaptation against the reviewed upstream commit.
4. Run repository checks and the complete hosted Challenge, DNS, editor,
   compression, Monitor and Gateway suites. Use hosted CI for image and editor
   tests on the work Mac. Retain licences, recipes, descriptors and package hashes.
5. After review and merge, use the
   [checkpoint publication and activation runbook](aws-checkpoint-activation.md)
   to publish immutable main-source images and inspect fresh scans of their exact
   digests. Resolve the whole image gate before opening admission.

Archive service or network failures must fail the build. Do not fall back to a
live sid index or silently select a newer package. Recheck archive availability
and the selected versions before changing any pin.

Source: https://snapshot.debian.org/#Usage

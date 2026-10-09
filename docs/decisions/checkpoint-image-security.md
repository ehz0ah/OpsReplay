# Checkpoint image security refresh

Status: implemented locally, ECR verification pending
Date: 10 October 2026
Owner: Cloud contributors

## Context

The first ECR scan reported six critical findings in each published Node runtime image.
Five were attributed to the Debian Perl source package at `5.36.0-7+deb12u3`. One was
GnuTLS `CVE-2026-95210` at `3.7.9-2+deb12u7`. The Challenge image reported the same
GnuTLS finding. Debian provides a later Bookworm Perl package, but it does not currently
provide a Bookworm fix for the GnuTLS finding. Debian also postpones at least one of the
reported Perl findings.

The disposable repositories and their images were removed after the checkpoint. A new
publication is therefore required to learn the exact finding set for the refreshed
images.

## Decision

Refresh the immutable Node 22 and Debian Bookworm base-image pins. Run `apt-get upgrade`
in a shared Node base stage before the gateway and Monitor build and runtime stages. Run
the same upgrade before installing the Challenge packages. Remove the APT indexes after
each operation.

Require `perl-base` `5.36.0-7+deb12u4` or later in both Node runtime image tests. Keep the
existing content-specific publication tag because Debian package repositories can
produce different image bytes for the same Git commit.

This change applies available distribution updates. It does not add a vulnerability
allowlist, ECR scan gate, new infrastructure, or runtime feature. It does not claim that
all reported findings are fixed.

## Alternatives and consequences

Keeping only the prior base pins leaves known available updates unapplied. Pinning every
Debian package version would prevent routine security updates and require a separate
package-lock process. Replacing the runtime distribution could reduce its package set,
but that is a larger runtime and operations decision and is not required to apply the
available fixes.

The build remains reproducible at the base-image layer. Package resolution uses the
current Debian Bookworm repositories. The image configuration digest in each immutable
publication tag distinguishes later builds when repository contents change.

## Validation

Build and test all three images. Confirm the gateway and Monitor runtime package floor.
Run the repository checks and quality checks. These local checks verify image behavior
and the installed Perl package version only.

After merge, publish all three images through the existing manual workflow. Inspect the
new ECR scans and record each remaining finding before another AWS runtime test. The
GnuTLS finding and any postponed Perl finding remain open until the distribution and a
new registry scan provide evidence that they are resolved.

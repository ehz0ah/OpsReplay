# Minimal Node runtime images

Date: 29 October 2026
Status: implemented candidate; local verification recorded below, AWS verification pending.

## Reason

The 29 October ECR scans found six util-linux and one system-zlib HIGH finding in
each Gateway and Monitor image. Available Bookworm updates did not change those
package versions. Neither service starts a shell, uses these utilities or links
the system zlib library. Learners use a separate Challenge image.

## Change

Build bundles with the existing pinned Node 22.23.3 Bookworm image and package
updates. Assemble the runtime root from digest-pinned distroless
`base-nossl-debian12`. Replace its older CA certificates and timezone files with
current Bookworm data before copying that root into the final `scratch` stage.
Copy the exact Node binary, its required libstdc++/libgcc libraries and their truthful
Debian package records. Preserve distribution metadata and licence notices.
Do not remove metadata to hide scanner findings.

The build explicitly installs CA certificates, which the slim Node base omits.
The copied CA/timezone data, package records, file hashes and licence notices all
come from those installed packages. The final runtime contains CA certificates
`20250419~deb12u2` and timezone data `2026e-0+deb12u1`. Removed certificates and
older zoneinfo files do not remain in the assembled root. Build-only OpenSSL,
package scripts and shell utilities do not enter that root.

The runtime omits util-linux, system zlib, Perl, the package manager and shell.
It also omits the unused system OpenSSL library. Node's built-in TLS and compression
remain available. The first `cc-debian12` candidate included an old OpenSSL package
with a fixable HIGH finding; it was rejected rather than accepted as residual risk.
The final base's keyless signature was verified against the distroless Google identity.

Keep `node` UID/GID 1000, the entrypoint, manifest paths, ports, stop signal and all
deployed resource and isolation settings. Copy passwd/group records so the existing
ECS `node` and `1000` overrides keep the same identity. Do not change the Challenge
image, learner tools, private content, public API or stored attempts.

Only the Monitor `test` target adds the FIFO fixture utility and its libraries.
These files and test clients do not enter `runtime`, `reference` or `stale-dns`.
Tests inspect file absence in the real production targets. Tests now use Node for
identity and filesystem checks because shell commands are intentionally unavailable.
Write-denial checks require actual `EROFS` or `EACCES`, not a missing `touch` binary.

## Verification and limits

The image check verifies exact Node version, UID/GID, distribution metadata,
unwanted package and utility absence, parsing of all 148 system CA certificates,
TLS setup with that trust store, Singapore timezone behaviour and compression.
Gateway runtime tests cover DynamoDB Local discovery, health, ticket consumption, failure handling
and shutdown. Real Challenge/Monitor suites exercise startup rejection, TLS,
read-only storage, captures, traps, alternative repairs and sustained recovery.

Local verification passed: three composed Gateway image tests, five real terminal/
recording client tests and eight Monitor image tests for each Challenge. Gateway's
457 code tests passed. Monitor's 53 code tests passed with one Linux-only test skipped
on macOS; the Docker capture/FIFO check passed separately. Repository quality and
contract checks passed. These checks do not replace the AWS checkpoint.

Local test clients use the host architecture. On this ARM Mac, both the full Node
baseline and candidate clients exhausted the former 64 MiB limit, including a
native recording-loss control. Their test-only limit is now 128 MiB. The same
baseline loss test passes at that bound. Failure reports include container state.
No Gateway or Monitor deployment allocation, queue bound or timeout was increased.
These fixtures are not capacity or memory-performance measurements.

Trivy 0.76.1 scanned the final Gateway, reference Monitor and DNS Monitor candidates:
each had zero HIGH/CRITICAL/UNKNOWN, 21 MEDIUM and 11 LOW OS findings.
No remaining finding has a listed fixed version. Updating CA/timezone payloads
removed the three UNKNOWN advisories in the earlier minimal candidate. A comparison
with the full Node baseline using the same scanner database found no introduced
package/advisory pair in these final candidates. This is a local OS comparison,
not a comparison of ECR and Trivy severity counts.
This scan used preserved Debian metadata. It did not scan bundled application
dependencies or establish Node's complete security status. The unchanged production
npm lockfile audit separately reported no known findings.

The local result is not ECR clearance or AWS validation. Before activation, publish
through the reviewed main-only workflow, scan the exact final digests and run the
grouped AWS checkpoint. Keep existing version/digest pins and running attempts intact.
Any replacement admission uses the existing deployment-binding process. The Challenge
image's prior findings, including Vim swap recovery, are not fixed by this change.

## Alternatives and rollback

A newer Node or Debian major release would change more than the missing dependency
set requires. Removing editors from the learner image would change the product and
would not fix the service images. Runtime package removal is the smaller boundary.

Before activation, revert the Dockerfiles and matching image tests to the previous
runtime. No data migration or cloud mutation is part of this PR. After publication,
retain all images and task revisions used by existing sessions until normal drain.

Source: https://github.com/GoogleContainerTools/distroless

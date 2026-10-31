# Challenge curl refresh

The 31 October exact-digest ECR scans report two critical curl findings in each
Challenge image: `CVE-2026-86414` and `CVE-2026-92388`. Bookworm's installed
`7.88.1-10+deb12u15` remains vulnerable. The curl project lists no published
vulnerabilities for its 8.23.0 release as checked on 1 November.

Build curl 8.23.0 from the exact Debian `8.23.0-1` source obtained through signed
APT indexes. Only a sid source repository is added in the builder. All build and
runtime dependencies stay on Bookworm. Verify the upstream source archive against
the SHA-256 published in the Debian source descriptor. Do not install sid binary
packages or migrate libc.

Replace both the command and OpenSSL libcurl4 binary package with a Bookworm build.
Keep the shared library ABI name, versioned symbols, existing package dependencies,
CA paths, compression, HTTP/2, SSH, LDAP and GSSAPI support. Retain the existing
services, tools, default editor, image entrypoint and task isolation. The derived
DNS image receives the same packages.

Each local package records its actual version, local origin, upstream licence,
Debian source descriptor and build recipe. Recompute the package file inventory.
The package-specific slim include rules retain the new provenance and checksum
targets. This is an OpsReplay rebuild, not an official Bookworm security release.

Ordinary hosted tests must verify real HTTP requests, the matching curl/libcurl
version, supported protocols and package hashes. The complete reference, DNS and
Monitor suites remain required. No local Docker or malformed-input test runs on
the work Mac. Fresh exact-digest scans remain required after merge and publication.

This rebuild addresses curl. The same image change also rebuilds Vim and zlib.
Util-linux and glibc findings remain open. Successful builds do not clear the
image gate or authorize Challenge admission.

Sources:

- https://curl.se/download.html
- https://curl.se/docs/vuln-8.23.0.html
- https://security-tracker.debian.org/tracker/source-package/curl
- https://deb.debian.org/debian/pool/main/c/curl/curl_8.23.0-1.dsc
- https://sources.debian.org/src/curl/8.23.0-1/

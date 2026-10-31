# Challenge Vim source refresh

Fresh 31 October ECR scans still report high findings against Bookworm's Vim
9.0.1378 source, including issues outside the single recovery backport. The
current Debian Vim source is `2:9.2.0858-1`, newer than the fixes referenced by
the high findings on the current scanner list.

Use this exact source through a source-only sid repository and signed APT
indexes, and verify the upstream archive SHA-256. Build with Debian's Tiny
configuration and Bookworm compiler and library packages. No sid binary package,
full-feature editor, GUI, service change or libc migration is introduced.

Replace Vim Tiny and its matching common configuration/documentation package.
The small feature set, aliases, Nano default and local origin remain. Package
metadata identifies the actual upstream release and Bookworm rebuild. Preserve
licence, source descriptor, build recipe and complete file checksum records.
The earlier recovery patch is included in the newer upstream source and is not
applied a second time.

Hosted tests must check ordinary editing through all three aliases, Unicode,
valid swap recovery created by a normal edit, matching package versions and
complete package verification. No malformed sample, local editor execution or
Docker build runs on the work Mac. Existing service/Monitor suites remain required.

This is a candidate. Hosted compilation and fresh exact-digest scans determine
readiness. Other package findings remain separate, and Challenge starts stay
closed until the whole image set qualifies. Existing attempts keep their pins.

Sources:

- https://security-tracker.debian.org/tracker/source-package/vim
- https://packages.debian.org/sid/vim-tiny
- https://deb.debian.org/debian/pool/main/v/vim/vim_9.2.0858-1.dsc
- https://sources.debian.org/src/vim/2%3A9.2.0858-1/

# Fixed SQLite shared library

The 4 November exact-image gate at source `75db441` found three new HIGH SQLite
findings: `CVE-2026-119373`, `CVE-2026-119374` and `CVE-2026-119379`.
Gateway and Monitor scans had no findings. Admission stayed closed. These findings
are not covered by the existing glibc acceptance, and no new waiver is requested.

Debian's `3.54.1-1` changelog names fixes for all three findings and the associated
SQLite issues. Build that source with Bookworm dependencies. Use the signed
`20261104T000000Z` source snapshot, because the package was uploaded after the
existing `20261031T000000Z` snapshot. Verify both code and Debian patch archives.
Do not install sid binary packages or upgrade the distribution libc.

Replace only the existing `libsqlite3-0` shared object. Preserve Bookworm paths,
symlinks, permissions and package dependencies. Keep its public SQLite and session
extension APIs and legacy `libsqlite3.so.0` SONAME. Debian's non-amalgamated build
also exposes implementation symbols. Removed private symbols are recorded, not
asserted as stable public APIs. Refresh symbol metadata and derive ELF dependencies.

Retain source, copyright, recipes, local package version and checksums. Do not
remove the package or suppress scanner metadata. No learner command or scenario
definition changes. Existing attempts keep their saved pins.

Both hosted Challenge suites check normal Python queries, transactions, Unicode,
BLOBs, JSON, FTS5, R-Tree, disk backup, a normal session changeset and package hashes.
The normal fault, recovery, traps, Monitor and Gateway checks remain required. No
exploit fixture or local native test is added. Hosted tests and a fresh merged-source
ECR qualification are required before runtime activation. This decision does not
claim that the revised images have passed those gates yet.

Sources read 4 November 2026:

- https://metadata.ftp-master.debian.org/changelogs/main/s/sqlite3/sqlite3_3.54.1-1_changelog
- https://deb.debian.org/debian/pool/main/s/sqlite3/sqlite3_3.54.1-1.dsc
- https://sources.debian.org/data/main/s/sqlite3/3.40.1-2%2Bdeb12u2/debian/rules
- https://sources.debian.org/data/main/s/sqlite3/3.54.1-1/debian/rules
- https://sqlite.org/releaselog/3_54_1.html

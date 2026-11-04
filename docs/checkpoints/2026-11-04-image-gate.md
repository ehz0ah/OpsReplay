# Image gate and early cleanup, 4 November 2026

Status: exact-source publication completed, image gate failed, runtime not activated.
This checkpoint does not claim fresh gameplay, browser QA or production readiness.

## Source and publication

PR #140 received independent approval, merged as
`75db441331afae0fcf45ab16a27fbe549881c5b2`, and main CI run
`41770681330` passed all nine repository jobs. Range-diff confirmed the rebased
CI patch was unchanged. Both image publications used this exact merged source:

- Wrong upstream port: run `41776097414`.
- Stale DNS record: run `41776148001`.

Both build and publish jobs passed. Qualification checked each digest manifest,
embedded scenario hash, ECR manifest/configuration digest and complete fresh scan.
Passing build tests did not override the image gate.

| Image              | SHA-256 digest, without the `sha256:` prefix                       |
| ------------------ | ------------------------------------------------------------------ |
| Upstream Gateway   | `2075b5af4d58e263a3bbf9fee7492cb56b8dcc0d4045fa4777d1a68ed7af9148` |
| Upstream Monitor   | `80140095458b6f61e4ce1f39aa243584bc364341ed01c5143429b7f4befbcbef` |
| Upstream Challenge | `4772cdcb824372700d9ec1eb9ff7ccf9f0eff3b154b2339953f7be427b935794` |
| DNS Gateway        | `d050b553d33248a29ab966bce9173887f2105026e41ed3c3203695c21d881946` |
| DNS Monitor        | `c6417a9e0d9c9926878e472a3857f367fffaa9e832804cb9c69ab20308dc5750` |
| DNS Challenge      | `3fb2740cf84d6ea51b1fd44dc52a45074c66102b52873fc3e0c86769101f24c2` |

## Finding and required fix

All six scans were COMPLETE. Both Gateway and both Monitor scans had no findings.
Each Challenge had 4 HIGH, 12 MEDIUM and 4 LOW findings, with no CRITICAL or UNKNOWN.
The new unaccepted HIGH findings were `CVE-2026-119373`, `CVE-2026-119374` and
`CVE-2026-119379`, reported against SQLite source version `3.40.1-2+deb12u2`.
The remaining HIGH was the previously scoped glibc finding `CVE-2026-84243`.

Both Challenge scans contain the same findings. Relative to 1 November, the nine
new MEDIUM findings and one new LOW finding are listed below. The seven earlier
findings retain the same CVEs, severities and package versions; the dated
[1 November residual table](../../SECURITY.md#1-november-exact-image-qualification)
does not describe the additions.

| Finding           | Severity | Reported source package/version | Remediation status                |
| ----------------- | -------- | ------------------------------- | --------------------------------- |
| `CVE-2026-119371` | MEDIUM   | sqlite3 `3.40.1-2+deb12u2`      | SQLite rebuild; fresh ECR pending |
| `CVE-2026-119372` | MEDIUM   | sqlite3 `3.40.1-2+deb12u2`      | SQLite rebuild; fresh ECR pending |
| `CVE-2026-119375` | MEDIUM   | sqlite3 `3.40.1-2+deb12u2`      | SQLite rebuild; fresh ECR pending |
| `CVE-2026-119376` | MEDIUM   | sqlite3 `3.40.1-2+deb12u2`      | SQLite rebuild; fresh ECR pending |
| `CVE-2026-119378` | MEDIUM   | sqlite3 `3.40.1-2+deb12u2`      | SQLite rebuild; fresh ECR pending |
| `CVE-2026-119591` | MEDIUM   | sqlite3 `3.40.1-2+deb12u2`      | SQLite rebuild; fresh ECR pending |
| `CVE-2026-119377` | LOW      | sqlite3 `3.40.1-2+deb12u2`      | SQLite rebuild; fresh ECR pending |
| `CVE-2026-114690` | MEDIUM   | gcc-12 `12.2.0-14+deb12u1`      | Unrelated to SQLite; open         |
| `CVE-2026-114691` | MEDIUM   | gcc-12 `12.2.0-14+deb12u1`      | Unrelated to SQLite; open         |
| `CVE-2026-115455` | MEDIUM   | gcc-12 `12.2.0-14+deb12u1`      | Unrelated to SQLite; open         |

The scan descriptions place these SQLite findings before `3.54.0`. PR #141
replaces the affected library with `3.54.1`, so the six SQLite MEDIUMs and one LOW
are expected to clear along with the three HIGHs. This is a version-based
expectation, not a fresh scan result. The three GCC MEDIUMs are outside that fix
and remain open for separate assessment. No new acceptance covers them.

Runtime admission stayed closed. No new waiver was requested or applied. No
scanner finding or package metadata was suppressed. [PR #141](https://github.com/ehz0ah/OpsReplay/pull/141)
rebuilds the SQLite library from Debian `3.54.1-1` source on Bookworm, with normal
compatibility checks in both image suites. At head `6836d5f`, run `41779083987`
passed all nine repository jobs and the metadata title check. The upstream image
suite passed 25 tests, including the SQLite 3.54.1 query, changeset and package-hash
check. The DNS and combined Monitor/Gateway jobs also passed. Independent approval,
merge and fresh merged-source qualification remain required. This checkpoint does not
claim that PR #141 has passed a new ECR gate or was deployed.

## Bounded preparation and cleanup

The approved three-hour window opened at 04:51 UTC, with a two-hour new-work cutoff
and one hour reserved for cleanup. US$5 was a planning target, not a billing cap.
Only preparation ran: private foundation, static browser hosting, unused edge
protection and a temporary Cognito client/domain. The original playback CORS
parameter was saved before a reviewed playback-only change. Thirty-five allowed
static assets were uploaded; application configuration was never published.

The image failure stopped activation. No SessionStart runtime stack, Challenge
attempt, Gateway service, assistant credential copy, demo Pro grant or Ark call
was created. App/browser QA did not run.

Cleanup removed all four exact run-owned stack IDs, their ECR repositories/images,
and the empty temporary browser bucket after checking its 35 object keys and ETags.
The built assets can be regenerated from source. The original publisher-variable
absence and durable playback CORS parameter were restored. Final verification
found the same retained stack IDs in both Regions, unchanged durable template,
parameters and outputs, unchanged retention settings, both protected records and
all 13 protected-owner rows, no ECS cluster and no unfinished lifecycle, recording
or assistant work. The window closed early and before its cleanup deadline.

## Evidence and remaining work

The operator-local `opsreplay-final-iteration-20261104` ledger retains the source
lock, artifact metadata, six scan receipts, reviewed change sets, object inventory
and final preservation verification. Credentials, raw identity/store records and
provider data remain outside Git. Earlier campaign receipts were not changed.

The [cost comparison](../reports/final/cost-comparison.md) separates new posted
account-scoped estimates from campaign attribution. This window's final attributable
charges remain pending. Real participant count is zero. Equivalent-host capacity
and power measurements, study ownership details and a six-speaker rehearsal are
still missing. No synthetic fixture is described as a participant result.

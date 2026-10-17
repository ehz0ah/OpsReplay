# Stale DNS record

Draft networking Challenge. The storefront responds, but checkout fails because
`api.internal` still points to a retired loopback address. nginx keeps the address
it resolved at startup. Correcting DNS alone does not repair the proxy connection.

## Local verification

From the repository root with Node 22 and Docker:

```sh
npm ci
npm run challenge:dns:build
npm run challenge:dns:test
npm run monitor:image:build
npm run monitor:dns:image:build
npm run monitor:dns:image:test
```

The DNS image derives from the existing shop, database, terminal server, and recording
implementation. The build script creates a temporary base tag for this build and removes
it afterwards. CoreDNS is pinned by digest. The image adds its own DNS zone, API address,
nginx routing, service startup, and watched directories.

Image tests verify the initial fault, DNS-only partial repair, the reference repair,
persisted checkout, a fresh reset, the broken-zone trap, and an alternative repair that
moves the API listener back. Monitor integration verifies real traffic, 60 seconds of
sustained recovery, outage observations, and capture isolation. Each test removes its
containers. These checks do not prove Fargate behaviour.

## Release candidate

`OpsReplayStaleDnsEnvironment` registers a separate candidate task definition using the
shared environment stack. It has no task IAM role, no shared process namespace, and a
read-only Monitor mount. Session launch and recording use the existing backend.

Select `stale-dns-record` in the manual checkpoint image workflow to build and test the
matching Challenge and Monitor images. Publication checks the embedded manifest, exact
image digests, and task family before admission. The existing content-review, repeat,
playback, secrecy, and Fargate-isolation gates still apply. This PR does not publish or
deploy the Challenge. It remains Pro/Medium as defined by the original draft.

The incident is synthetic. It is not attributed to a specific public postmortem.
CoreDNS is Apache-2.0 software. Its licence is included under
`image/rootfs/usr/local/share/licenses/coredns`.

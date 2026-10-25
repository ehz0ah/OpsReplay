# Presentation SaaS experience

Status: implemented locally. Visual browser and AWS validation pending.

## Direction

OpsReplay is an incident practice lab. The identity uses IBM Plex Sans for the
interface, IBM Plex Mono for operational detail, warm paper surfaces, graphite
text and a muted signal-orange accent. A response/replay loop forms the original
mark and homepage diagram. The diagram explains the workflow; it is not fake
telemetry or a claimed learner recording.

Reference pages: https://incident.io/ and https://linear.app/. Their public pages
inform operational focus, product-first explanation and developer-tool hierarchy.
No competitor code, logo, artwork, testimonials or performance claims are copied.
Visual-reference screenshots remain pending. The fonts are pinned Fontsource
packages under the OFL-1.1 licence, self-hosted as WOFF2. No external font or image
request is added. Existing terminal, telemetry, review and playback logic stays intact.

Marketing copy uses one section label per page, short supporting text and plain
mode names. Repeated decorative labels and the extra hero footnote are omitted. This
reduces visual noise without changing navigation or learner behaviour. Native text
token pairs pass a static 4.5:1 contrast calculation; computed styles, viewport fit
and keyboard behaviour still require browser validation.

## Customer journey

`/pricing` gives two access options and labels S$12/month as a proposal. Free
retains the complete sample experience. No unlimited runtime, large content count,
institutional administration or working billing is advertised. The financial
assumptions and break-even limits are in [pricing proposal](pricing-proposal.md).

`/upgrade` is labelled demo checkout. It collects no card or payment details.
Sign-in and signup return to the exact `/upgrade` route using the existing PKCE
flow. The browser calls the same authenticated API as other mutations, saves an
owner-scoped request before dispatch and reuses it after uncertain responses.
Only a correlated definite rejection discards the receipt. Invalid responses
cannot trigger activation success. A new account read confirms current Pro
access; a saved receipt alone is not current entitlement.

`/account` shows the server plan and expiry. Activation does not start, end or
reset an attempt. The existing current-attempt notice and History remain intact.
Approved fixed-window access, default-off configuration and existing Pro
preservation follow [demo grants](demo-pro-grants.md).

The auth return allowlist and CloudFront route function add only the three exact
routes. No general HTML fallback, arbitrary redirect or query-driven entitlement
is introduced. Hashed WOFF2 assets use the existing private S3/CloudFront path,
self-only font CSP and immutable cache. HTML and account data remain uncached.

## Checks and rollout

The browser test runner explicitly uses the existing browser JSX configuration,
while server typechecking stays separate. Tests cover lost responses, current
credentials, indefinite Pro grants, correlated denial, malformed responses,
owner/kind isolation, corrupted receipts, exact routes and proposal disclosure.

Deploy the updated browser validators and exact route rules before enabling the
optional account metadata. Old strict clients reject added fields. Confirm
real Cognito return navigation, denial, double activation, refresh and grant
preservation in one controlled AWS window. Check desktop, mobile, keyboard
navigation, font loading, overflow and existing learner workflows before marking
the visual work ready. No local test substitutes for these checks.

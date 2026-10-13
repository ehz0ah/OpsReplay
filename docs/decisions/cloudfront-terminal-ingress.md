# CloudFront terminal ingress increment

Status: implemented and tested locally, AWS validation pending
Date: 13 October 2026
Owner: Cloud and Gateway contributors

## Context

The MVP needs a trusted public WSS endpoint without domain registration. The current
terminal ingress requires an external ACM certificate and hostname. CloudFront provides
an AWS-managed hostname and certificate. Its VPC origins support private ALBs in
`ap-southeast-1`. This increment supersedes the public ALB, certificate input, and
regional WAF design in [terminal ingress deployment](terminal-ingress-deployment.md).
It preserves the [checkpoint activation gates](checkpoint-activation.md).

## Decision

Use this terminal path:

```text
Browser WSS → CloudFront → VPC origin → internal HTTP ALB → private Gateway → private Challenge
```

CloudFront terminates viewer TLS. The internal ALB runs in the existing two isolated
workload subnets, listens on HTTP 80, routes only `/v1/terminal`, and returns 404 for
other paths. It retains the Gateway `/healthz` target check, HTTP/1.1 forwarding,
60-second idle timeout, and bounded deregistration. Gateway tasks remain private. Their
connection limits, exact Origin checks, first-frame single-use ticket authentication,
20-second Ping, recording, and lifecycle behaviour do not change.

The ALB security group accepts TCP 80 from the AWS-managed
`com.amazonaws.global.cloudfront.origin-facing` prefix list in the workload Region.
The operator supplies the verified ID. AWS documents this as a supported VPC-origin
ingress method. This increment does not create or edit the AWS-owned
`CloudFront-VPCOrigins-Service-SG`. Restricting to that group would require an additional
lookup after origin creation. The supported prefix list avoids that dependency and a
custom resource. It has weight 55 against the security-group rule quota. Its ID and
quota must be checked before deployment. The ALB has no public address or internet route.

The existing foundation retains its internet gateway, which CloudFront VPC origins
require. The gateway does not provide an internet route to workload subnets. The existing
public subnets remain foundation resources. No new task permissions, NAT, endpoint,
or internet route are added. The VPC origin explicitly depends on the ALB listener
route. CloudFront still needs an active ALB and available private IPv4 addresses.

The terminal distribution requires HTTPS and uses HTTP/1.1. Its origin request policy
forwards `Origin` and the recommended `Sec-WebSocket-*` headers. CloudFront handles
`Connection` and `Upgrade` for the WebSocket handshake. Query strings are forwarded so
the Gateway can reject them. Cookies and viewer Authorization are not forwarded because
terminal authentication uses the first frame. The ticket Lambda and stack output use
the distribution-derived `wss://<distribution>.cloudfront.net/v1/terminal` URL. A
conditional empty URL keeps the disabled Lambda independent of an absent distribution.

Disable object and error caching for this terminal distribution. The ALB has no cache
to remove. An established WebSocket carries live frames. Do not cache rejected upgrades
across users. Future frontend assets can use a separate cached behaviour. This increment
does not host the frontend, move REST APIs, or change their authentication or throttling.

Move the existing terminal-path rate rule to `TerminalEdgeProtectionStack` in
`us-east-1` with WAF scope `CLOUDFRONT`. It defaults off, as does the workload runtime.
Deploy the edge stack first and pass its Web ACL ARN as an explicit workload parameter.
No cross-Region CloudFormation exports or Lambda custom resources are needed.
Workload activation rejects a missing edge ARN. The rule groups by viewer source IP,
with the existing default of 300 terminal-path requests per 60 seconds. AWS WAF rate
limits are approximate. It does not trust `X-Forwarded-For`, which clients can supply.
Request sampling is disabled to avoid collecting attempted query credentials or browser
headers. CloudWatch counts remain enabled. WAF does not inspect established socket frames.

Remove `PublicIngressSubnetIds`, `TerminalCertificateArn`, `TerminalGatewayUrl`, and
`TerminalUpgradeRateLimitPerIp` from workload inputs. Add `CloudFrontOriginPrefixListId`
and `TerminalEdgeWebAclArn`. The rate parameter moves to the edge stack. Runtime and
admission remain default-off. No changes to published images are required by this code.

## Alternatives and consequences

A public ALB origin preserves external certificate dependencies and exposes another
public ingress. A regional WAF source-IP rule behind CloudFront groups by CloudFront
addresses. Using the first `X-Forwarded-For` address for that rule permits spoofing.
Edge WAF preserves viewer rate limiting without a header-rewrite function.

The default CloudFront certificate has an AWS-fixed `TLSv1` security policy. Current
browsers can negotiate TLS 1.2 or 1.3, but this does not preserve the old ALB minimum
TLS 1.2 policy. Enforcing a custom minimum requires a custom hostname and certificate.
The CloudFront-to-ALB hop uses HTTP inside the private origin path. Private networking
is not application-layer TLS. These are explicit MVP trade-offs for review and must
be accepted in the approved AWS test record. If the deployment requires a TLS 1.2
minimum or encrypted origin transport, this configuration is insufficient.

CloudFront adds a connection-establishment hop. No latency or capacity improvement is
claimed. Its documented origin-to-viewer WebSocket idle limit is 10 minutes. Gateway
Ping every 20 seconds is intended to keep the connection active, but must be tested.
CloudFront and edge WAF add usage charges. VPC-origin creation and deletion can take
minutes. Disassociate the distribution before disabling edge WAF or removing the VPC.

## Validation

Local template tests check the internal ALB and network edges, HTTPS viewer policy,
WebSocket and Origin forwarding, query preservation, disabled object and error caching,
required edge configuration, correct WAF Region and source-IP aggregation, default-off
resources, generated ticket URL, and absence of dependency cycles. Existing tests cover
the unchanged API authentication, action IAM, runtime gates, and Gateway relay.

Local checks do not prove CloudFront VPC-origin provisioning, WebSocket upgrades,
security-group reachability, WAF enforcement, TLS negotiation, idle behaviour, or latency.
After review and explicit AWS approval, test the exact PR head before merge. Keep the
image workflow restricted to `main`. Use previously reviewed images only if they exist
and their exact digests and current scans pass the activation runbook. Record public
and private routing, invalid Origin and ticket rejection, query rejection, long-lived
terminal operation, reconnects, WAF including spoofed forwarding headers, recording,
lifecycle cleanup, latency, cost, and teardown. No deployment is part of this PR work.

AWS references:

- [VPC origins](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html)
- [WebSocket requirements](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html)
- [Managed prefix list](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/LocationBasedPolicy.html)
- [Viewer certificate and policy](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesGeneral.html)
- [WebSocket quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html)
- [WAF scope and Region](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-wafv2-webacl.html)
- [Forwarded-IP rules](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-forwarded-ip-address.html)

# Reference runtime publication

Date: 13 October 2026

## Decision

Publish the reference Challenge only through a reviewed two-step operation:

1. inspect the exact tested image configurations and registered task revision;
2. complete the embedded draft manifest by changing only its status and two image digests;
3. require evidence references for repeated scenario tests, playback, Fargate isolation,
   public-data secrecy, and independent content review;
4. conditionally store the immutable private manifest;
5. verify that stored value with a consistent read; and
6. conditionally create the public admission snapshot.

The embedded manifest cannot contain the final digest of its own Monitor image. The
release descriptor therefore binds the embedded build-manifest hash and the completed
private-manifest hash separately. Publication does not rebuild either image.

Use a separate content-publisher role. It can read the two ECR manifests, describe task
definitions, and get or put only `CONTENT#*` items in the shared table. ECS does not support
resource-level permissions for `DescribeTaskDefinition`, so that read-only action uses
`Resource: "*"`; the tool still validates the exact account, Region, family, revision,
and complete task shape. The role cannot push images, register tasks, pass roles, deploy
infrastructure, or admit sessions through an API.

## Reason

Admission must never refer to an untested image, a generic Monitor image, a mutable tag,
or private content that was not stored. Conditional writes make identical retries safe
and reject a conflicting use of the same Challenge version. Storing private content
first means an interrupted operation can leave an unused private item, but cannot leave
a startable version without its pinned manifest.

## Limits

The tools do not prove AWS behaviour until the approved checkpoint runs. Evidence
references are reviewed operator assertions, not cryptographic proof of the underlying
test results. The Pro time limit remains an explicit input because the team has not
selected it. No current draft is promoted by this change.

17 October 2026: live `DescribeTaskDefinition` responses include empty Docker labels,
Linux device/tmpfs/capability-add lists, and log secret options. Release inspection
omits these known empty defaults. Non-empty additions still fail the exact task check.

17 October 2026: the reference candidate advances to `0.1.1` and declares only
request rate, error rate and p95 latency. Publication checks each dashboard ID,
source and unit against the Monitor's measurement descriptors. CPU and memory
collection remains unimplemented. No existing content record or saved attempt is
rewritten. The candidate needs fresh image qualification and review before apply.

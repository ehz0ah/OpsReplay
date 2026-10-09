# Checkpoint image publication

Status: verified in AWS; disposable resources removed
Date: 9 October 2026
Owner: Cloud contributors

## Context

The disposable foundation defines three ECR repositories. The gateway, Monitor, and
first Challenge images need a reviewed process that tests them, publishes them, and
returns the exact digests required by later task definitions. Long-lived AWS keys must
not be stored in GitHub.

## Decision

Use one manually triggered GitHub Actions workflow. It runs only for the exact commit
selected from `main`. It builds and tests all three `linux/amd64` images before it asks
AWS for credentials.

GitHub presents its signed OIDC token to AWS STS and assumes a checkpoint publisher role.
The role trust requires the `sts.amazonaws.com` audience and the exact subject
`repo:ehz0ah@130889443/OpsReplay@1378586293:environment:aws-checkpoint`. This uses the
immutable owner and repository IDs enabled for this repository. The publish job declares
that environment. Its deployment rule permits only `main`, and a required reviewer can
be added before the first publication. The role permissions are limited to ECR
authentication and image reads and writes in the three checkpoint repositories. It has
no CloudFormation, S3, ECS, Lambda, IAM mutation, or general deployment permission.

The disposable foundation accepts a verified account-level GitHub OIDC provider ARN. It
does not own the provider. A separate one-resource prerequisite stack is available only
when the account does not already contain the GitHub provider. This keeps provider
ownership stable across foundation updates and deletion. Deployment instructions require
a read-only account check before selecting either path. A reused provider must have the
exact GitHub token URL and include `sts.amazonaws.com` in its client ID list.

Each repository receives an immutable
`git-<40-character-commit-sha>-<image-configuration-digest>` tag. The content suffix lets
a later build of the same commit publish different bytes without colliding with a prior
immutable tag. The publisher reads each configuration digest from the `Config` entry in
the tested `docker save` archive. It does not depend on image-store-specific `docker
image inspect` output. Before a push, the workflow uses `BatchGetImage`. It reuses an
existing tag only when its image configuration digest matches the tested archive. A
mismatch stops publication before registry login or any push. A repeated or partially
completed run pushes only missing images. Any response other than one image or an
explicit `ImageNotFound` failure stops publication. Docker receives the ECR password on
standard input, never as an argument.

The workflow writes a versioned JSON manifest containing the commit, Region, repository,
tag, digest, and digest-pinned URI for each image. It also writes the digests to the job
summary and retains the manifest artifact for seven days. It does not edit a Challenge
manifest automatically.

## Limits and validation

This increment does not bootstrap CDK, create an AWS resource, package Lambda code,
deploy an application stack, define an environment task, activate a Lambda, or start an
ECS task. Lambda ZIP files remain CDK deployment assets in the bootstrap S3 bucket. They
are not container images and are not published to ECR.

Local tests cover the separate provider boundary, exact environment trust subject,
publisher permissions, Docker archive formats, content-specific tag reuse, partial
publication, digest validation, and `main` enforcement. Workflow syntax, environment
selection, and action pins are checked separately.

GitHub Actions run `37965328481` completed the first manual AWS checkpoint on 10 October 2026. It built and tested all three images before it obtained temporary credentials,
published them through OIDC, and returned digests that matched the live ECR repositories.
A later checkpoint ran the private gateway Fargate service from the exact published
digest without a public IP. The disposable service, foundation, and image repositories
were then removed. The GitHub environment variable was also removed. The account-level
OIDC provider and standard CDK bootstrap stack remain.

This evidence proves the publication path and bounded gateway runtime tested by that
checkpoint. It does not prove a complete Challenge session, recording path, or later
image build. Each changed image still requires its own publication and ECR scan before a
new AWS runtime claim.

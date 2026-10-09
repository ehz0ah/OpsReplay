# Checkpoint image publication

Status: implemented locally, AWS publication pending
Date: 9 October 2026
Owner: Cloud contributors

## Context

The disposable foundation defines three empty ECR repositories. The gateway, Monitor,
and first Challenge images are tested locally, but no reviewed process publishes them or
returns the digests required by later task definitions. Long-lived AWS keys must not be
stored in GitHub.

## Decision

Use one manually triggered GitHub Actions workflow. It runs only for the exact commit
selected from `main`. It builds and tests all three `linux/amd64` images before it asks
AWS for credentials.

GitHub presents its signed OIDC token to AWS STS and assumes a checkpoint publisher role.
The role trust requires the `sts.amazonaws.com` audience and the exact subject
`repo:ehz0ah/OpsReplay:ref:refs/heads/main`. Its permissions are limited to ECR
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
immutable tag. Before a push, the workflow uses `BatchGetImage`. It reuses an existing
tag only when its image configuration digest matches the tested local image. A mismatch
stops publication before registry login or any push. A repeated or partially completed
run pushes only missing images. Any response other than one image or an explicit
`ImageNotFound` failure stops publication. Docker receives the ECR password on standard
input, never as an argument.

The workflow writes a versioned JSON manifest containing the commit, Region, repository,
tag, digest, and digest-pinned URI for each image. It also writes the digests to the job
summary and retains the manifest artifact for seven days. It does not edit a Challenge
manifest automatically.

## Limits and validation

This increment does not bootstrap CDK, create an AWS resource, package Lambda code,
deploy an application stack, define an environment task, activate a Lambda, or start an
ECS task. Lambda ZIP files remain CDK deployment assets in the bootstrap S3 bucket. They
are not container images and are not published to ECR.

Local tests cover the separate provider boundary, exact trust subject, publisher
permissions, content-specific tag reuse, partial publication, digest validation, and
`main` enforcement. Workflow syntax and action pins are checked separately. Only a
manual run after the foundation deployment can prove STS federation, ECR permissions,
image upload, and the returned managed-service digests.

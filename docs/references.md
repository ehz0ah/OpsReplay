# Design references

These sources support the design. They do not prove product uniqueness or measured
capacity. The API Gateway and Lambda extracts were checked on 21 September 2026, and the
ECS, Fargate, ECR, Scheduler, and ALB extracts on 24 and 25 September 2026. Recheck the
Region, runtime, quotas, and rates before deployment.

## Education

- [Google: Postmortem Culture](https://sre.google/workbook/postmortem-culture/)
  describes Wheel of Misfortune exercises based on previous postmortems.
- [Google: Incident Response](https://sre.google/workbook/incident-response/)
  discusses drills and reviewing their outcomes.

## API tier

- [AWS: REST APIs and HTTP APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html)
  compares gateway features, including response streaming.
- [AWS: HTTP API quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html)
  documents the HTTP API integration timeout.
- [AWS: API Gateway response streaming](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode.html)
  documents streaming configuration and constraints.
- [AWS: Lambda response streaming](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html)
  documents runtime support, regional limits, and disconnect billing.
- [AWS: DynamoDB transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)
  documents transaction limits and the client-token idempotency window.
- [AWS: DynamoDB constraints](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html)
  documents the 400 KB item limit.

## Environments

- [AWS: Architect for Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html)
  states that each task has its own isolation boundary and shares no kernel, CPU,
  memory, or network interface with another task.
- [AWS: Fargate security considerations](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-security-considerations.html)
  documents that privileged containers are unavailable, that only `SYS_PTRACE` can be
  added, and that containers in one task share a network namespace and ephemeral storage.
- [AWS: RunTask](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_RunTask.html)
  documents the `clientToken` idempotency parameter, `startedBy`, and overrides.
- [AWS: Fargate task metadata endpoint v4](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-metadata-endpoint-v4-fargate.html)
  documents `/task/stats` for all containers in a task.
- [AWS: ECR interface VPC endpoints](https://docs.aws.amazon.com/AmazonECR/latest/userguide/vpc-endpoints.html)
  lists the ECR, S3, and CloudWatch Logs endpoints needed without internet access.
- [AWS: EventBridge Scheduler schedule types](https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html)
  documents one-time schedules, one-minute precision, and quota use after completion.
- [AWS: Application Load Balancers](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html)
  documents the default 60-second idle timeout.

The team retains the course specification separately. Do not publish course materials in
this public repository without permission.

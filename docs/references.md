# Design references

These sources support the design. They do not prove product uniqueness or measured
capacity. The AWS extracts were checked during report preparation on 21 September
2026. Recheck region, runtime, quotas, and rates before deployment.

- [Google: Postmortem Culture](https://sre.google/workbook/postmortem-culture/)
  describes Wheel of Misfortune exercises based on previous postmortems.
- [Google: Incident Response](https://sre.google/workbook/incident-response/)
  discusses drills and reviewing their outcomes.
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

The team retains the course specification separately. Do not publish course
materials in this public repository without permission. The report snapshot
records the relevant submission requirements.

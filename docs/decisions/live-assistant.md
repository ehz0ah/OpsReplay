# Live investigation assistant

Status: implemented locally. AWS streaming and a paid provider remain unverified.

The optional assistant explains recorded public evidence during a ready Challenge.
It does not execute commands or change outcomes. The later
[proposal increment](confirmed-proposals.md) adds explicit learner confirmation. Terminal and hints remain available
when it fails. Code Review chat and proposals are separate increments.

Context contains the alert, title, tier, up to eight completed recorded commands,
visible metrics, aggregate recovery, released hints, and four recent completed turns.
The context builder never loads a private manifest. Output excerpts remain bounded;
missing, stale, or truncated evidence must remain explicit in the reply.

One transaction reserves a request ID, worker token, 60-second deadline, conversation
slot, and assistance count. The provider/context budget is 45 seconds. Only one turn
runs per session, with at most 50 admitted turns. Retries resolve the saved receipt
before checking provider availability or current session status. They cannot call the
provider again. Reads and the existing sweep release expired slots conditionally.
Completion requires the same active turn, worker, session state, and an unexpired
deadline. Late workers cannot overwrite a later turn.

Each API action has its own Lambda and role. POST uses API Gateway REST streaming
and Lambda's proxy metadata delimiter. GET reads saved turns. The send action stays
at zero concurrency until AssistantEnabled, endpoint, model, secret ARN, and gateway
runtime are configured. `AssistantConcurrencyLimit` sets shared send concurrency and POST burst.
`AssistantRateLimit` sets POST requests per second. Both default to one and allow 1-64.
The per-session slot remains one. Saved-turn GET retains concurrency/burst two and
rate one. Larger settings need Lambda quota, provider quota, polling and load checks;
these parameters alone do not establish classroom capacity. Secrets Manager supplies the
server-side raw API key; prompts and responses are excluded from logs. Logs record
turn duration, status, and provider token counts. Secret rotation requires a fresh
execution environment because the successful credential read is cached.

Before enabling an endpoint, the operator must evaluate the provider's retention,
training and data-handling terms. Questions, recent command/output excerpts, visible
metrics, released hints and recent chat leave AWS for that configured endpoint. The
browser states this before the question field. It does not assert unverified provider
policies. Gameplay remains available without the assistant.

The browser treats streamed text as provisional and polls the owned saved turn.
A disconnect retains the request ID. Recovery uses that ID; a new question creates
a new ID. End-of-stream alone does not prove completion. The UI uses plain text.

Local validation uses DynamoDB Local, a fake provider, and Lambda wire fixtures.
Cloud transport, real model accuracy, latency, cost, and quotas need the separate AWS
checkpoint. Disable AssistantEnabled to stop new provider work without removing
saved GET access.

Sources: [API Gateway streaming](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode-lambda.html),
[Lambda proxy format](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-streaming-lambda-configure.html).

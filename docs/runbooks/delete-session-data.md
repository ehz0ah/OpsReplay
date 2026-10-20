# Delete one completed session

Status: implemented locally. Managed IAM and S3 deletion require the AWS checkpoint.

The evaluation owner handles a learner's deletion request. Verify the requester and
record the requested session IDs privately. This action deletes one session, terminal
and Monitor recordings, captures, assistant turns, proposals, start receipt and history
reference. It preserves progress counts, other sessions, review submissions, account
grants and Cognito identity. It is not account deletion.

## Preparation

Deploy `OpsReplaySessionDeletion` with the existing `SessionTableName` and
`RecordingBucketName`. It creates one Lambda and its execution role. It creates no
public route, trigger, data resource or automatic workflow. Concurrency defaults to
zero. Enable it only for the approved operator window with `EnableSessionDeletion=true`.
Grant the operator `lambda:InvokeFunction` on the exact `DeleteSessionFunctionArn`.
The payload owner is a target check, not an authentication credential.

The session must have a terminal outcome and debrief, complete or incomplete recording,
finished playback export, confirmed stopped task, deleted schedules, no recording or
assistant work, and no active lock naming it. Resolve `NOT_QUIESCENT` through normal
finalisation. Cleaned attempts that never became ready need no debrief or playback.
Do not edit records to bypass the check. Versioned or suspended-versioning
buckets are rejected because a delete marker would not erase older object versions.

## Invocation

Store this request in a private temporary file. Replace the values with verified IDs:

```json
{
  "operation": "delete_session",
  "ownerId": "11111111-1111-4111-8111-111111111111",
  "sessionId": "22222222-2222-4222-8222-222222222222"
}
```

```sh
aws lambda invoke --profile opsreplay --region ap-southeast-1 \
  --function-name '<DeleteSessionFunctionArn>' \
  --cli-binary-format raw-in-base64-out \
  --payload file:///private/path/delete-request.json \
  /private/path/delete-result.json
```

Run synchronously. Read the function result, not only the CLI status:

| Result     | Meaning and next action                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| `pending`  | State is fenced and a marker is saved. Wait at least two minutes and invoke the identical target again.    |
| `deleted`  | Recording prefix, session partition, matching start receipt and history reference were verified absent.    |
| `absent`   | A repeated request verified no session data or matching owner references remain.                           |
| `rejected` | No completion claim. Resolve the code or repeat after `RETRY_REQUIRED`. Keep the request until completion. |

The first transaction removes session state and saves a marker. Session reads stop and
history omits that entry. A fixed two-minute delay covers bounded workers already in
flight. The marker retains only target identity and receipt/history keys. Later passes
delete the recording prefix first, then bounded table batches, then atomically remove
the marker and owner references. Partial failure retains the marker and can be retried.
Each invocation has a 60-second timeout and page bounds. No request launches, stops or
invokes another runtime action.

After `deleted` or `absent`, remove the private request/result files, record completion
without terminal content, and disable the function. Deletion cannot be rolled back.
Disabling stops new invocations; a saved marker must still be completed.

## Limits

The action removes live application data. DynamoDB point-in-time recovery and existing
backups retain previous data until their configured expiry. It does not erase study
exports held outside the application, review submissions, identity records or copies a
learner saved. The evaluation owner must remove private study files separately and
explain these limits before consent. Never confirm complete account erasure from this
one-session result.

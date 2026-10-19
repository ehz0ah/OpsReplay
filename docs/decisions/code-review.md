# Code Review increment

The browser reads a published diff and context, then stores a request ID before
submitting flags and concerns. The API validates every file, side, and line. A
flag matches every reference range that contains it. Unmatched concerns carry no
penalty. Concerns are retained as text and are not graded.

The submission transaction conditions publication, current access grant, and the
learner's prior submission count. It commits the owned result, request receipt,
and seen count together. Findings are returned only after that commit. Competing
requests cannot both be the first uninformed submission. A duplicate request reads
the owned receipt before checking current publication or plan, so lost responses
remain recoverable after withdrawal or expiry.

Published bundles are immutable private table items. Catalogue projection and
publication pointer commit together after schema and diff-range validation. A
build never publishes a draft. The new proxy rollout exercise is original and
synthetic. Independent content review and AWS publication remain pending.

The read and submit endpoints are separate Lambda functions with narrow IAM and
bounded concurrency. They never start an environment or call another Lambda.
The existing public ReviewExercise and ReviewSubmission schemas apply.

Local checks include real DynamoDB transactions, concurrent duplicate/distinct
submissions, ownership, missing lines, version changes, lost responses and access
expiry. Browser checks exercise saved-request recovery. AWS behavior is untested.

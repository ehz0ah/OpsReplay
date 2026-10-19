# Learner history increment

New session admission and review submission transactions also create one immutable
history reference in the learner's partition. A failed transaction cannot create an
orphan history entry. No new global index or table scan is used.

Owner-authorised list actions query those references newest first. The first page
fixes an upper key; continuation excludes newer entries. The cursor binds the owner
and record kind, but never grants access. Every referenced session or submission is
read again with ownership and identity checks. Current status is read from session
state, so an admission-time summary cannot remain active after completion.

The browser lists attempts and review results, labels retries and answer-informed
submissions, and links to the existing session/debrief flow. Result reads use the
saved access grant and remain available after a plan expires.

Older attempts have no history reference. Before enabling history for an existing
learner, an authorised operator runs `npm run history:backfill -- TABLE OWNER REGION`.
The bounded migration queries that owner's existing start/review receipts, checks
the referenced owner, and conditionally adds identical history records. It never
changes outcomes, scores or receipts. Repeating it is safe. No automatic migration
or AWS write occurs during a build or deployment.

Local transaction, ownership, pagination and migration checks apply. AWS history
rollout and the existing-record migration remain pending.

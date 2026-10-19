# Confirmed command proposals

Status: implemented locally. No AWS rollout or paid model validation.

The model has one typed `propose_command` function. The server accepts at most one
single-line command and rationale, marks common disruptive commands, and rejects
control bytes and obvious shell/environment exit commands. This filter is not a shell
sandbox. Commands run inside the existing isolated learner environment.

Turn completion saves text, proposal and slot release in one transaction. A failed
turn cannot publish a proposal. The expiry is ten minutes or session end, whichever
comes first. A proposal does not execute until the learner confirms its exact text
in a separate modal. Status queries use `query_proposal` and cannot dispatch.

Gateway validates the saved owner, session, expiry and current input generation.
It conditionally saves a delivery token before asking the terminal to deliver. Manual
input and proposal requests share the existing connection queue and terminal lock.
The terminal checks foreground Bash and prompt markers. A private Readline binding
then checks `READLINE_LINE` itself. Partial text remains untouched. The binding
records acceptance before evaluating the command in the current shell. Acceptance
means dispatch, not successful execution. A command marker carries proposal attribution;
markers remain learner-controlled reflection evidence, never scoring proof.

Each token is consumed once. A definite busy rejection permits a later explicit
confirmation with a new token. Missing acknowledgement is unknown and never resends.
Recovery queries only the terminal receipt and can publish an accepted status and
assistance count atomically. The terminal keeps at most 100 delivery receipts and
blocks later dispatch while a trigger remains uncertain. This binding evaluates commands in a function frame, so assignments persist but commands
that inspect Bash function scope can behave differently from a typed top-level command.
Receipt loss or a modified
shell integration can prevent automatic delivery; manual investigation still works.

The new terminal advertises `proposals: true`. Gateway accepts legacy ready frames
and refuses proposal delivery without this capability. Both unpublished Challenge
candidates move to version 0.1.2. Publication must create new immutable image pins;
existing attempts keep their old images and manifests. Reverting Gateway and UI
removes proposals. Do not publish changed bytes under an existing version.

Local checks include real Bash busy/partial-input/duplicate cases, DynamoDB Local
concurrent confirmation and recovery, typed provider streams, attribution, and legacy
terminal compatibility. AWS publication and end-to-end model calls remain separate.

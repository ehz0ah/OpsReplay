# Learner sign-up and review flow

23 October 2026. The user requested a full browser test, working sign-up and an
inline Code Review experience after completing the temporary trial.

## Authentication

The durable Cognito pool permits self-registration and verifies email. The
browser's Create account action opens Cognito's hosted `/signup` endpoint. It
uses the existing code flow, S256 PKCE, nonce, stored state and allowed return
paths. The normal callback reads that shared state. Passwords and confirmation
codes stay in the hosted form. A new account receives the server's default Free
access; registration creates no Pro grant.

This is a policy update to the existing retained pool. It does not replace the
pool or add an authentication service. Test deployments must restore any
temporary policy change when their approved window ends.

## Code Review

The unified diff has explicit Before and After gutters, a file navigator and
comments below the selected line. A learner can save, edit or delete a comment.
An unfinished editor must be saved or cancelled before another line or submission
can be selected.

Drafts use bounded session storage keyed by learner, exercise and exact version.
They include both saved comments and the unfinished editor. Invalid storage is
reported and is not silently removed. A storage failure leaves the in-memory
draft available and explains that refresh can lose it.

Submitting first shows the comment count and explains that findings will be
revealed. The existing saved request remains the only submission during uncertain
delivery. Its flags are frozen. A pending older version is recovered separately
from the current diff. Success opens the server-owned result URL, so refresh
reopens the same result. The current diff is shown only when its version matches
the saved result; missing access or a changed version does not hide that result.

Line matching still checks reference ranges. It does not grade written reasoning.
Findings remain unavailable before submission. The API and its transactions are
unchanged.

## Recovery display

The browser animates toward the latest confirmed recovery time. It never advances
beyond that sample, predicts success, or changes validation and scoring. A failed
check resets the display. Reduced motion disables animation. The timer stops at
the last confirmed sample if no further update arrives.

See the [browser checkpoint](../checkpoints/2026-10-23-learner-experience.md) for
observed AWS flows and local checks. It is a developer test, not a learning study.

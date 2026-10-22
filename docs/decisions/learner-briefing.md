# Challenge briefing

22 October 2026. First learner trial showed that an alert and terminal were insufficient
for a learner unfamiliar with the environment. Learners need system documentation before
the incident starts and throughout investigation.

The catalogue opens a briefing before launch. Reading it creates no task and starts no
clock. The same versioned briefing remains available in a workspace tab. It lists only
service roles and known file paths, plus general read-only command guidance. It does not
give current file contents, expected listener values, diagnosis, solution, validators,
traps or unreleased hints.

Public briefings live separately from private Challenge manifests. Browser assets use a
bounded, strict `ChallengeBriefing` schema and lazy imports restricted to that directory.
The session's exact Challenge version selects the briefing. Missing documentation is
labelled unavailable. It cannot silently substitute another version.

The launch confirmation explains root access, recording, readiness, the continuing
wall clock, the five-minute disconnection limit, and automatic recovery confirmation.
The existing saved-request and entitlement checks still own admission. These UI changes
do not change session state or the Challenge images. A new backend action is unnecessary
for a small public documentation library.

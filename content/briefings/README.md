# Public Challenge briefings

These files are written for learners. They contain service roles, known configuration
and log paths, and a general environment overview. They do not contain port numbers,
file contents, the fault, solution commands, validators, traps, or unreleased hints.

Use `<challenge-id>/<challenge-version>.json`. Keep earlier versions for saved
attempts. The browser lazy-loads only this directory and validates the exact identity
and `ChallengeBriefing` schema. It never imports a Challenge manifest. Missing older
briefings are labelled unavailable; they do not use another version's documentation.

Review the text alongside the associated Challenge. Current-version file locations
are checked against the authored manifest by `npm run content:test`. Changing the
briefing does not mutate an environment, score or published admission record.

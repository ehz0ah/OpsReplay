# Learner content delivery

22 October 2026. The trial uploaded web scripts and HTML but omitted the generated
Free lesson JSON files. The Learn route loaded, but its lesson index returned 403.
Published Code Review and Pro lesson records were also absent from the catalogue.

Build and deployment are distinct. The browser upload plan now includes every Free
lesson referenced by the generated index, then the index and HTML. It checks file
identity, version, plan, bounds and regular-file paths before returning a plan.
Only reviewed content is published through the existing explicit publishers.
Private Pro bodies and review findings remain server-side.

Learn waits for both its Free static index and public catalogue. A source failure
does not imply an empty library. A successful source can still show its entries,
and the failed source retains a retry action. Empty copy appears only when both
sources completed without error and neither returned entries.

Recovery seconds remain measured values from saved server samples. A short bar
transition and explicit sampling note explain progress without extrapolating health
or declaring success in the browser. The server still confirms sustained recovery.

No public API, scoring, session lifecycle or provider contract changes are needed.

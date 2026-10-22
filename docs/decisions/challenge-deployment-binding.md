# Published Challenge deployment binding

22 October 2026. Removing a temporary runtime deregisters its task revision. The
published content and saved session pins remain immutable, so a later deployment
needs a separate binding for new admissions.

An operator validates the replacement task, image configurations and unchanged
scenario against the reference release checks. The binding is stored at
`CONTENT#<id> / DEPLOYMENT#<version>`. It contains the exact original content pins
and the validated replacement pins. It cannot change the Challenge, plan, alert,
hints, scoring rules or time limits.

Start reads this record strongly alongside publication and account state. It
rejects a binding that does not match the exact published pins or changes the task
family, account or Region. Its admission transaction checks both publication and
binding unchanged. A concurrent replacement retries admission. The saved session
copies the selected pins, and every retry of that request uses its saved receipt.

An absent binding retains the existing publication behaviour. The immutable
publisher does not write this mutable deployment record. Operator writes must use
conditional replacement, retain their prior value for rollback, and occur with
admission closed. Existing manifests remain available by hash for old debriefs.

No public endpoint, browser contract or new Lambda/IAM permission is needed.
Rollback closes admission, removes or restores the binding conditionally, and
restores the prior start bundle. Never change pins of an admitted session.

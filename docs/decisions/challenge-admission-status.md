# Challenge start availability

The authenticated account read with `include=admission` reports `challengeStartsEnabled` from the same
deployment condition that controls StartSession concurrency. GetAccount remains a
read-only action and requires no additional IAM permissions. A missing or invalid
runtime environment value reports false.

When false, the catalogue explains the temporary limit, disables new start and
recovery requests, and offers an account refresh. Existing attempts and retained
results stay accessible. An uncertain saved start request keeps its original
identity and can be recovered after admission reopens. The UI does not discard a
request or claim that an earlier attempt never started from this status alone.

Default account reads omit this field so existing browsers keep their exact
response shape. The field is optional for factory or test responses without
deployment configuration. Deploy the updated backend first, then the browser
that requests admission status. Admission changes
update both StartSession concurrency and GetAccount's status environment value.
API responses use no-store caching, but an already open page needs a refresh to
see a later deployment change. Backend concurrency remains the enforcement point.

This decision adds no plan, billing, scenario or gameplay mode. Pro does not bypass
a deployment pause.

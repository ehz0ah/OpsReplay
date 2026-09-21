# Web application boundary

Status: not implemented. Follow [design](../../docs/design.md) and
[API](../../docs/api.md). The frontend framework is open. The output must support
static hosting unless the deployment decision is explicitly revised.

Own navigation, evidence views, charts, accessible action controls, saved progress,
debrief, replay comparison, and optional chat. Consume public contracts only.
Never import private content or calculate authoritative transitions and scores.

First task: build the Challenge workspace against the contract examples, then
connect it to the local API. Include loading, retry, stale-version, terminal, and
provider-failure states. Add the actual development command when a runnable app
exists. Do not add a fake start command to this baseline.

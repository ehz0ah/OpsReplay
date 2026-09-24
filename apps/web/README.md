# Web application boundary

Status: not implemented. Follow [design](../../docs/design.md) and
[API](../../docs/api.md). The frontend framework, terminal emulator, and chart library
are open. The output must support static hosting.

Own navigation, plan display, Learn, the Challenge workspace with terminal, dashboard,
and timeline, hints, the optional assistant, debrief, playback, retry, and Code Review.
Consume public contracts only. Never import files from `content/` or calculate recovery,
evidence, or scores.

First task: build the workspace against the contract examples, including provisioning,
reconnecting, replaced, outcome, and provider-failure states. Then connect it to the
local gateway and API. Do not add a fake start command before a runnable app exists.

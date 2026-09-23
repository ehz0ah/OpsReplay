# Scenario engine boundary

Status: local engine implemented. [Simulation](../../docs/simulation.md) is the
normative behaviour contract. The independent reference calculator remains a
specification fixture. Tests run its expected traces through this engine.

Own rule evaluation, state transitions, simulated time, metrics, event triggers,
cost components, terminal conditions, checkpoint state, and deterministic debrief.
Accept definitions and validated commands as data. No AWS SDK, HTTP framework,
provider client, wall-clock reads, random values, or browser dependency.

Public operations are `compileScenario`, `start`, `step`, `project`, `end`,
`debrief`, `replay`, and `compare`. Compile each pinned definition before starting
sessions. `step` validates commands itself and returns a candidate state with an
event batch. The API must commit them atomically with its request receipt.

The engine keeps the latest observation per evidence ID and ten intervals of
metric/log history for bounded queries. The API stores full logical events and
their immutable observations separately. Pure reads do not advance time.

Tests cover reference traces, expression bounds, invalid commands, evidence
timing, checkpoint capture, and replay isolation. Published content still needs
authored success, failure, and alternative traces plus a human content review.

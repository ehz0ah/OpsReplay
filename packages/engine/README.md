# Scenario engine boundary

Status: not implemented. [Simulation](../../docs/simulation.md) is the normative
behaviour contract. The reference fixture calculation checks the specification
only and must not be treated as a production engine.

Own rule evaluation, state transitions, simulated time, metrics, event triggers,
cost components, terminal conditions, checkpoint state, and deterministic debrief.
Accept definitions and validated commands as data. No AWS SDK, HTTP framework,
provider client, wall-clock reads, random values, or browser dependency.

First task: implement start/step/project operations and run the reference traces.
Add bounded rule/type validation and meaningful failure tests. Published content
must run through the real engine before release.

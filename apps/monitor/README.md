# Monitor container boundary

Status: not implemented. Follow [Challenge environments](../../docs/challenges.md) and
the [manifest schema](../../packages/contracts/schemas/challenge.schema.json).

A shared image that runs beside each challenge container. Own traffic journeys,
dashboard metrics, validators, health probes, the initial-state health check, per-command
captures, and the authenticated control port for the gateway. It has no AWS credentials
and never exposes validator or probe definitions. Treat watched files as untrusted: read
regular files only, never follow links, and cap reads.

Protect the control channel with authenticated TLS. Keep secrets, buffer storage, and
processes private. Timestamp capture intervals rather than attributing each file change
to a command. The fixed checkout validator verifies creation and a matching order read,
not HTTP status alone. Fargate isolation remains an integration-test requirement.

First task: run the reference Challenge's journeys, validators, and probes under local
Docker, and pass the scenario harness for the reference fix and each trap.

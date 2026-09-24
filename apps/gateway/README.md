# Gateway service boundary

Status: not implemented. Follow the [gateway protocol](../../docs/api.md#terminal-gateway-protocol),
[Challenge environments](../../docs/challenges.md), and [architecture](../../docs/architecture.md).

Our own small WebSocket proxy, run as an ECS service behind the ALB. Own ticket checks,
the terminal proxy, the dashboard relay from the monitor, asciicast recording, command
events from shell markers, capture requests, heartbeats, and confirmed proposal runs.
It is the only component that connects to environment tasks, and it writes recordings
and captures to private S3.

First task: proxy and record a local challenge container's terminal, form command
events, and store captures, then play the session back with matching output.

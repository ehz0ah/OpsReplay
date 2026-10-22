# Learner navigation and progress feedback

22 October 2026. The first learner trial identified missing orientation and weak
feedback while the environment started and the debrief was prepared.

The home page at `/` explains the actual workflow. `/challenges` holds the catalogue,
with the existing briefing and start flow. CloudFront rewrites only that exact new
route. Sign-in return paths allow it. Existing session, lesson, review and history
routes keep their meanings. Product pages omit course branding.

Use Mantine Select for catalogue and playback choices instead of native HTML selects.
It supplies an in-app menu, keyboard handling and the existing design system. No new
UI library is needed. Keep selections controlled and disallow unintended deselection.

Use a shared visible loader and status text for application bootstrap, account and
catalogue reads, start confirmation, provisioning, terminal opening, outcome
confirmation and debrief preparation. The loader shows work in progress, not an
invented percentage or estimated finish time. Errors keep their existing retry paths.
Reduced-motion users still receive status text.

Pages outside the workspace show a notice for the owner's current attempt. The
account endpoint supplies the active ID and the existing session observer reads
authoritative state. The notice distinguishes startup, running, stopping/finalisation,
and a saved result. It never claims that a ready incident is paused. Failed status
reads use an unavailable message rather than presenting stale state as current.

Navigation does not preserve a terminal socket, send a heartbeat or change the time
limit. The five-minute abandonment rule and ordinary reconnect semantics stay intact.
No API, IAM, container, scoring, admission or persistent-state changes are required.
The browser route change needs the normal static-stack deployment alongside assets.

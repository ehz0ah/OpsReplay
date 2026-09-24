# Shared contracts

Status: proposed v0.2, machine-validated specification baseline. Version 0.2 replaced
the pre-implementation simulated-engine contracts.

- [OpenAPI](openapi.json) defines REST routes and wire shapes.
- [Public schemas](schemas/public.schema.json) define REST types and the terminal
  gateway frames.
- [Challenge schema](schemas/challenge.schema.json) defines private Challenge manifests.
- [Review schema](schemas/review.schema.json) defines private Code Review bundles.
- [Examples](examples/README.md) provide synthetic payload fixtures.

Schemas cannot enforce ownership, conditional writes, isolation, or prompt boundaries by
themselves. The domain documents define those checks. Update documents, examples, and
checks with any contract change.

The frontend imports or generates public types only. Challenge and review schemas belong
to the API, gateway, monitor, and test harness.

After changing `public.schema.json`, run `npm run contracts:sync` to update the embedded
OpenAPI component schemas, then `npm run check`. Do not edit the embedded copy directly.

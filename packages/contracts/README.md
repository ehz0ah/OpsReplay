# Shared contracts

Status: proposed v0.1, machine-validated specification baseline.

- [OpenAPI](openapi.json) defines public routes and wire shapes.
- [Scenario schema](schemas/scenario.schema.json) defines private authored content.
- [Public schemas](schemas/public.schema.json) define shared response types.
- [Tool registry](tools.json) defines operation names, kinds, and argument schemas.
- [Examples](examples/README.md) provide public payload fixtures.

Schemas cannot enforce ownership, transaction semantics, or hidden evidence by
themselves. The corresponding domain documents define those checks. Update
documents and examples with contract changes.

The frontend imports or generates public DTOs only. Private scenario types belong
in API/engine code. Do not bundle this entire directory indiscriminately.

After changing `public.schema.json`, run `npm run contracts:sync` to update the
embedded OpenAPI component schemas, then `npm run check`. Do not edit the embedded
component copy independently. Tool argument shapes must also match `tools.json`.

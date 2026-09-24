# Shared contracts

Status: v0.1 contracts with generated TypeScript types and runtime validation.

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

Package entry points:

- `@opsreplay/contracts`: public types only, safe for browser imports.
- `@opsreplay/contracts/validation`: public runtime validation and safe errors.
- `@opsreplay/contracts/scenario`: private authored types for server code.
- `@opsreplay/contracts/server`: scenario shape validation and tool definitions.

After changing `public.schema.json`, run `npm run contracts:sync` to update the
OpenAPI components and generated types. For scenario schema changes, run
`npm run contracts:generate`. Then run `npm run check`. Do not edit generated
copies independently. Tool argument shapes must also match `tools.json`.

`validateScenarioShape` validates structure only. The engine must also check
references, expression types, bounds, selectors, and reachable outcomes.

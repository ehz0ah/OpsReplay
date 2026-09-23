# ADR 001: Local application stack

Status: accepted for the first local Challenge slice
Date: 2026-09-23
Owner: foundation contributor

## Context

Six contributors need a local application that uses the same contracts across the
browser, API, and deterministic engine. Direct play must work without AWS or an
LLM. The user approved React with Vite and a Fastify modular monolith.

## Decision

- Use npm workspaces and strict TypeScript. Keep one lockfile and Node 22 runtime.
- Generate public and private types from the existing JSON schemas. Use AJV for
  runtime validation without coercing input or removing unknown fields.
- Export public DTOs separately from private scenario types and server helpers.
- Use Fastify for the API. Keep engine code independent of Fastify and storage.
- Use React and Vite for the browser. Use shadcn/ui and Mantine where they meet a
  concrete need, with a shared theme and one owner for each basic control.
- Use Vitest, TypeScript checks, ESLint, and Prettier for application checks.
- Start with local persistence. Select its adapter when implementing atomic
  session writes and request receipts. AWS integration follows local correctness.

## Alternatives and consequences

A separate backend framework or microservice per module adds deployment and
communication work without a requirement in this slice. Fastify plugins provide
module boundaries within one API process. No Redis or message queue is required.

Handwritten DTOs would duplicate the schema. Generated types reduce that risk,
but cannot enforce ownership or scenario semantics. Those checks remain in the
application and engine. Generated files are committed and checked for drift.

Workspace exports point to TypeScript source. Local Node processes use `tsx`.
Vite builds browser output. Deployment packaging will use a separate build step
when the runtime target is validated. Packages are private and are not published.

TypeScript 6.0.3 is used because typescript-eslint 8.70.1 supports versions below
6.1. Version 7 is outside that range. Upgrade both tools together after checks.

## Validation

Node 22.23.1 runs the baseline schema checks and contract unit tests. Tests check
strict input handling, public evidence boundaries, error isolation, and registry
isolation. This records the initial stack check. See the
[local handoff](../local-handoff.md) for later API and UI validation. AWS deployment
remains unimplemented.

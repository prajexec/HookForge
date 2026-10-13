# ADR 0001: Runtime and framework

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

HookForge needs a small, typed backend with explicit HTTP behavior, structured
logs, and fast local feedback on an Apple Silicon laptop.

## Alternatives considered

- Express with a separate validation and logging composition.
- Fastify with its plugin lifecycle and Pino integration.
- A heavier application framework with an ORM and generated runtime.

## Decision

Use Node.js 22, strict TypeScript, Fastify, Zod, Pino through Fastify, `pg`,
native `fetch` in the worker, React, and Vite. Use npm workspaces rather than a
monorepo orchestration framework.

## Consequences

The project has explicit boundaries without a large dependency or memory
footprint. SQL and migration behavior remain visible to engineers. Some
conventions that an ORM would provide, such as generated models, must be
maintained deliberately through migrations and tests.

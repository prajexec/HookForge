# ADR 0009: Multi-stage Compose deployment topology

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

The local deployment must run on a resource-constrained Apple Silicon laptop,
must not copy host-native `node_modules` into Linux containers, and must not
acknowledge application startup before the schema is current.

## Alternatives considered

- Separate Dockerfiles and unrelated build contexts for API, worker, and web.
- A single development container with host-mounted source and dependencies.
- One root-context multi-stage Dockerfile with target-specific runtime images.

## Decision

Use one root-context multi-stage `Dockerfile` with `api`, `worker`, `migrate`,
and `web` targets. Build dependencies and artifacts inside a Node 22 Alpine
builder, install only workspace production dependencies in Node runtime targets,
and serve the Vite output with Nginx Alpine. Compose starts PostgreSQL and Redis,
runs a one-shot migration target, then starts API and worker only after required
health checks succeed. Nginx serves the dashboard and proxies same-origin
`/api/` requests to the API service.

## Consequences

The Dockerfile and lockfile provide one reproducible dependency path for ARM64
and CI. The migration job is visible and repeatable instead of hidden in an API
entrypoint. Local builds are larger than a source-mounted dev container but the
runtime images exclude compilers and test tooling. The worker has no HTTP health
endpoint yet, so Compose supervises its process and the database lease model
provides recovery; a worker heartbeat can be added when operational metrics need
it.

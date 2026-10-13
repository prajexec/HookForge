# HookForge

HookForge is a small, production-style webhook delivery platform. It is being
built incrementally to demonstrate durable event persistence, asynchronous
delivery, HMAC signatures, retry policy, tenant isolation, and operational
observability without requiring a heavyweight local stack.

## Current milestone

The repository currently contains the foundation milestone:

- TypeScript strict-mode npm workspace for API, worker, web, and shared code.
- Fastify API with `/health`, `/ready`, and `/metrics`.
- Zod environment validation, Pino-backed Fastify logging, security headers, and
  restricted local CORS defaults.
- PostgreSQL 16 and Redis 7 Alpine Compose services tuned for local ARM64 use.
- Transactional SQL migration runner with the initial `pgcrypto` migration.
- Unit tests for health, readiness, metrics, and configuration behavior.

The delivery domain, authentication, worker queue, dashboard data views, and
OpenAPI document are deliberately introduced in later tested milestones.

## Architecture direction

HookForge will remain a modular monolith with separate API and worker processes.
PostgreSQL is the source of truth for projects, endpoints, events, deliveries,
and attempts. The delivery queue will be PostgreSQL-backed and claimed with
`FOR UPDATE SKIP LOCKED`, so event creation and initial delivery scheduling can
share a transaction. Redis is reserved for short-lived coordination and rate
limiting; it will not be the only location for important event data.

See [the architecture overview](docs/architecture/ARCHITECTURE.md),
[the diagrams](docs/architecture/diagrams.md), and the decision records in
`docs/architecture/decisions/`.

## Technology

- Node.js 22 LTS-compatible runtime, TypeScript, Fastify, Zod, and Pino
- PostgreSQL 16 with `pg` and SQL migrations
- Redis 7 for ephemeral coordination
- React, Vite, and TypeScript for the dashboard
- Vitest, ESLint, Prettier, Docker Compose, and GitHub Actions

## Prerequisites

- Node.js 22.x and npm 10.x
- Docker Desktop for Apple Silicon with the Docker daemon running
- Git

The checked environment is ARM64. Compose uses Alpine images with ARM64
manifests and keeps PostgreSQL and Redis resource usage conservative.

## Quick start

```bash
cp .env.example .env
npm install
docker compose up -d
npm run db:migrate
npm run dev:api
```

The initial API is available at `http://localhost:3000`. The database and Redis
ports are intentionally private to the Compose network. To run the API directly
on the host, use the debug override, which binds both ports only to loopback:

```bash
docker compose -f docker-compose.yml -f docker-compose.debug.yml up -d
```

The web foundation can be started in a second terminal with
`npm run dev:web` and is available at `http://localhost:5173`.

## Commands

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run compose:logs
npm run compose:down
```

Run `docker system df` to inspect disk usage. Remove only this project's
stopped containers and images after inspection; never remove the named
`hookforge_postgres_data` volume unless you explicitly intend to reset local
data. The explicit reset command will be documented when the complete Compose
stack is available.

## Documentation

- [API documentation](docs/api/API.md)
- [Development guide](docs/development/DEVELOPMENT.md)
- [Security notes](docs/security/SECURITY.md)
- [Operations runbook](docs/operations/RUNBOOK.md)
- [Contributing](CONTRIBUTING.md)

## Screenshots and demo

Dashboard screenshot and delivery demo GIF placeholders will be added after the
real API-backed dashboard milestone.

## Current limitations and roadmap

The current milestone does not yet accept authenticated events or deliver HTTP
requests. The next milestones add the domain schema and project/endpoint APIs,
then idempotent event ingestion, the durable worker, signed delivery and
retries, replay, and the API-backed dashboard. Benchmarks will be added only
after delivery is functional and will report measured values with their test
environment.

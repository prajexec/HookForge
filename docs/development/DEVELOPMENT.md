# Development guide

## Local setup

Use Node.js 22.x and npm 10.x. On Apple Silicon, Docker Desktop must be
configured to use the native ARM64 engine. From a clean checkout:

```bash
cp .env.example .env
npm install
docker compose up -d
```

Compose builds the multi-stage API, worker, and web images and runs a one-shot
migration service before API/worker startup. The default stack publishes only
the API and web loopback ports; PostgreSQL and Redis remain private to the
Compose network.

Use the loopback-only debug override when application processes should run on
the host instead:

```bash
docker compose -f docker-compose.yml -f docker-compose.debug.yml up -d postgres redis
npm run db:migrate
npm run dev:api
npm run start:worker
npm run dev:web
```

## Environment

`DATABASE_URL`, `REDIS_URL`, `HOST`, `PORT`, `API_PORT`, `WEB_PORT`, `LOG_LEVEL`, `CORS_ORIGIN`,
`SESSION_TTL_SECONDS`, `MAX_EVENT_PAYLOAD_BYTES`, `SECRET_ENCRYPTION_KEY`, and
`ALLOW_PRIVATE_ENDPOINTS` are validated by Zod at API startup. Worker-specific
concurrency, lease, timeout, retry, and response-size settings are validated by
the worker process. `.env` is
ignored by Git. The example encryption key and database password are local-only
and must not be reused in production. Production refuses to start without an
explicit encryption key.

## Checks

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
```

Run `npm run dev:api`, `npm run start:worker` (after building), and
`npm run dev:web` in separate terminals. Vite proxies `/api` to the host API;
the dashboard keeps bearer tokens in memory only and does not use browser
cookies. Unit and route tests use in-memory dependency doubles and do not
require internet access. The integration command
requires the local PostgreSQL service and applies all migrations before testing
the real event and worker transactions.

## Migrations

Migrations are ordered SQL files in `db/migrations/`. Run `npm run db:migrate`
after the database is reachable. The runner creates `schema_migrations`, takes
a PostgreSQL advisory lock, runs each unapplied file in a transaction, and
records its version. Never edit an already-applied migration; add a new one.

The Compose `migrate` service runs this same runner and exits successfully
before `api` and `worker` are allowed to start. Its advisory lock also makes
manual reruns safe. The Compose image has separate `api`, `worker`, `migrate`,
and `web` targets in the root `Dockerfile`.

## Git workflow

Use a focused conventional commit after each verified milestone. Keep code,
tests, and documentation for a feature together. Do not commit `.env`, secrets,
`node_modules`, `dist`, coverage output, or database volumes. Review
`git diff` and `git status` before committing.

## Common issues

- If Docker commands cannot connect to the daemon, start Docker Desktop before
  running Compose.
- If an image build fails after changing dependencies, rebuild from the root with
  `npm run compose:build`; the Dockerfile installs Linux dependencies inside the
  build and runtime stages rather than reusing host `node_modules`.
- If readiness fails, inspect `docker compose ps` and
  `docker compose logs --tail=100 postgres redis migrate api worker`.
- If the web page loads but API calls fail, inspect `docker compose logs api web`
  and confirm Nginx is proxying `/api/` to the `api` service rather than
  `localhost`.
- If disk usage grows, inspect `docker system df` first. Do not use volume prune
  commands unless you have confirmed the named database volume is not needed.

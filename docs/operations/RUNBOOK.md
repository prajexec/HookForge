# Operations runbook

## Start and inspect

```bash
docker compose up -d
docker compose ps
docker compose logs -f --tail=100
```

`GET /health` checks process liveness. `GET /ready` checks the PostgreSQL and
Redis dependencies required by the API. Health responses intentionally omit
internal connection details.

## Graceful shutdown

Send SIGTERM to the API or worker process. The API stops accepting new work,
closes Fastify, then closes its PostgreSQL and Redis clients. The worker
milestone will release or expire leases during shutdown and will document its
exact drain timeout.

## Migrations and data

Run `npm run db:migrate` against the configured database before starting a new
application version. Back up PostgreSQL before production migrations. The local
named volume is `hookforge_postgres_data`; it is never deleted automatically.

Run `npm run test:integration` after starting local PostgreSQL to verify the
event transaction, idempotency behavior, active-endpoint fan-out, and rollback
against the real schema.

## Worker recovery

Build the worker with `npm run build`, then start it with
`npm run start:worker`. It polls pending deliveries, uses bounded concurrency,
and exits gracefully on SIGTERM after in-flight requests finish or time out.
Each claim has a lease. If the worker crashes, the next worker claim recovers
expired leases and increments the attempt count. Inspect the `deliveries` and
`delivery_attempts` tables directly until the delivery inspection API exists.

Worker defaults are intentionally conservative for local development:
concurrency 5, a 60-second lease, a 10-second request timeout, an 8 KiB
response excerpt, and 8 maximum attempts. Adjust them through `.env` only after
measuring the downstream and PostgreSQL workload.

## Logs and disk

Use `docker compose logs --tail=100 postgres redis` for dependency diagnostics
and structured API logs for request IDs. Check disk usage with
`docker system df`. Remove only project-specific stopped containers or unused
images after inspection. Do not run `docker volume prune` as a routine cleanup.

Use the delivery API to inspect failed rows and attempt history. To recover
expired leases for one project explicitly, call the reconcile route; normal
worker claims recover them automatically. Replay only terminal failures and
confirm the endpoint is active before replaying. Backups and broader incident
procedures should include both `deliveries` and `delivery_attempts`.

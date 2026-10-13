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

## Logs and disk

Use `docker compose logs --tail=100 postgres redis` for dependency diagnostics
and structured API logs for request IDs. Check disk usage with
`docker system df`. Remove only project-specific stopped containers or unused
images after inspection. Do not run `docker volume prune` as a routine cleanup.

Delivery retry inspection, abandoned-job reconciliation, backups, and incident
procedures will be expanded when the worker and delivery schema are implemented.

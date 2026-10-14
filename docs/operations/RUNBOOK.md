# Operations runbook

## Start and inspect

```bash
docker compose up -d
docker compose ps
docker compose logs -f --tail=100
```

Compose starts PostgreSQL and Redis, runs the one-shot `migrate` service, then
starts the API and worker. The web service starts only after the API is healthy.
`GET /health` checks process liveness. `GET /ready` checks the PostgreSQL and
Redis dependencies required by the API. Health responses intentionally omit
internal connection details.

The API container exposes port 3000 to loopback, and the Nginx web container
exposes port 80 as host port 5173. Nginx proxies same-origin `/api/` requests
to `api:3000`; the browser never needs to know the internal Compose hostname.

The worker health check queries its fresh PostgreSQL heartbeat. A worker that
stops heartbeating becomes unhealthy after 30 seconds and is restarted by
Compose, while any in-flight delivery is recovered by lease expiry. Inspect
`GET /metrics` for active worker count, configured concurrency, active jobs,
queue backlog, and delivery latency summaries.

## Graceful shutdown

Send SIGTERM to the API or worker process. The API stops accepting new work,
closes Fastify, then closes its PostgreSQL and Redis clients. The worker exits
its polling loops, allows the current bounded request to finish or timeout,
and leaves any unreconciled lease for normal expiry/recovery.

## Migrations and data

The Compose `migrate` service runs `npm run db:migrate` against PostgreSQL before
the API or worker starts. To run it manually on the host, use
`npm run db:migrate` after starting the debug database services. Back up
PostgreSQL before production migrations. The local named volume is
`hookforge_postgres_data`; it is never deleted automatically.

Run `npm run test:integration` after starting local PostgreSQL to verify the
event transaction, idempotency behavior, active-endpoint fan-out, and rollback
against the real schema.

## Worker recovery

Build the worker with `npm run build`, then start it with
`npm run start:worker`. It polls pending deliveries, uses bounded concurrency,
and exits gracefully on SIGTERM after in-flight requests finish or time out.
Each claim has a lease. If the worker crashes, the next worker claim recovers
expired leases and increments the attempt count. Inspect the `deliveries` and
`delivery_attempts` tables directly or use the delivery inspection API.

Worker defaults are intentionally conservative for local development:
concurrency 5, a 60-second lease, a 5-second heartbeat, a 10-second request
timeout, an 8 KiB response excerpt, and 8 maximum attempts. Adjust them through
`.env` only after
measuring the downstream and PostgreSQL workload.

## Logs and disk

Use `docker compose logs --tail=100 postgres redis migrate api worker web` for
dependency, migration, application, and proxy diagnostics. API logs include
request IDs and worker logs are structured JSON. Check disk usage with
`docker system df`. Remove only project-specific stopped containers or unused
images after inspection. Do not run `docker volume prune` as a routine cleanup.

Use the delivery API to inspect failed rows and attempt history. To recover
expired leases for one project explicitly, call the reconcile route; normal
worker claims recover them automatically. Replay only terminal failures and
confirm the endpoint is active before replaying. Backups and broader incident
procedures should include both `deliveries` and `delivery_attempts`.

## Rate limits

Default local limits are 10 authentication attempts per IP per 60 seconds and
120 event-ingestion requests per user/project per 60 seconds. Tune the explicit
`RATE_LIMIT_*` variables for a controlled benchmark; do not mistake a `429`
response for downstream delivery latency.

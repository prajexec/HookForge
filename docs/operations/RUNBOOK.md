# Operations runbook

## Start and inspect

```bash
docker compose up -d
docker compose ps
docker compose logs -f --tail=100
```

Compose starts PostgreSQL, Redis, and the bounded `mock-receiver`, runs the
one-shot `migrate` service, then starts the API, worker, and daily retention
service. The web service starts
only after the API is healthy. The receiver is published at
`http://localhost:8080` and retains captures in memory.
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
queue backlog, and delivery latency summaries. Scrape
`GET /metrics/prometheus` for API metrics; the worker's internal listener is
`http://worker:9464/metrics` inside the Compose network.

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

## Retention and partitions

The `retention` service runs once, sleeps for `RETENTION_INTERVAL_SECONDS`, and
runs again. It takes the `hookforge:retention` PostgreSQL advisory lock, creates
UTC monthly partitions, archives terminal event/delivery/attempt graphs, and
drops archive partitions after `PURGE_AFTER_MONTHS`. Pending or in-flight
graphs are left in the hot tables. Run a preview manually with:

```bash
RETENTION_DRY_RUN=true npm run db:retention
```

The archive parents are `hookforge_archive.events`,
`hookforge_archive.deliveries`, and `hookforge_archive.delivery_attempts`, all
`RANGE` partitioned by `created_at` (`delivery_attempts.created_at` mirrors
`request_at`). A graph is copied before hot rows are deleted. Inspect
`retention_partition_runs` and `pg_inherits` when diagnosing a maintenance run.

## Vault envelope-key rotation

Set `ENVELOPE_PROVIDER=vault`, `VAULT_ADDR`, `VAULT_TOKEN`, and
`VAULT_TRANSIT_KEY` on both API and worker. Enable Vault audit devices outside
HookForge. Rotate without stopping delivery with:

```bash
npm run db:rotate-encryption-key
```

The command marks the current key `retiring`, creates a new active wrapped data
key, and records an audit event. Do not mark retiring versions `retired` until
no endpoint secret or queued snapshot references them. Keep the legacy key
available while any pre-Vault ciphertext remains.

## Tracing

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to the OTLP/HTTP collector base URL and use
`OTEL_SERVICE_NAME` per process. Ingestion records W3C trace context on the
event, the worker starts a consumer span after claiming the PostgreSQL queue,
and the receiver call is a child span with propagated `traceparent` headers.
Do not place payloads, secrets, URLs, request IDs, project IDs, or endpoint IDs
in span attributes or Prometheus labels.

## Worker recovery

Build the worker with `npm run build`, then start it with
`npm run start:worker`. It polls pending deliveries, uses bounded concurrency,
and exits gracefully on SIGTERM after in-flight requests finish or time out.
Each claim has a lease. If the worker crashes, the next worker claim recovers
expired leases and increments the attempt count. Inspect the `deliveries` and
`delivery_attempts` tables directly or use the delivery inspection API.

Worker defaults are intentionally conservative for local development:
concurrency 5, one in-flight delivery per endpoint, five per project, a
60-second lease, a 5-second heartbeat, a 10-second request timeout, an 8 KiB
response excerpt, and 8 maximum attempts. Adjust them through `.env` only after
measuring the downstream and PostgreSQL workload.

All worker processes that share a database must use the same
`WORKER_MAX_IN_FLIGHT_PER_ENDPOINT` and `WORKER_MAX_IN_FLIGHT_PER_PROJECT`
values. A mixed deployment has no single effective quota; drain old workers
before changing these settings.

## Logs and disk

Use `docker compose logs --tail=100 postgres redis migrate api worker mock-receiver web` for
dependency, migration, application, and proxy diagnostics. API logs include
request IDs and worker logs are structured JSON. Check disk usage with
`docker system df`. Remove only project-specific stopped containers or unused
images after inspection. Do not run `docker volume prune` as a routine cleanup.

Use the delivery API to inspect failed rows and attempt history. To recover
expired leases for one project explicitly, call the reconcile route; normal
worker claims recover them automatically. Replay only terminal failures and
confirm the endpoint is active before replaying. Backups and broader incident
procedures should include both `deliveries` and `delivery_attempts`.

## Bulk operations and dead letters

Bulk replay and cancellation accept at most 100 explicit delivery IDs and
require an `Idempotency-Key`. A pending delivery becomes `cancelled`; an
in-flight delivery records a cancellation request and is cancelled after its
current attempt completes. Cancellation cannot retract an HTTP request already
sent to a receiver.

Terminal worker failures are marked with `dead_lettered_at` and
`dead_letter_reason`. Configure a project dead-letter alert destination with the
alerts API; HookForge creates a signed metadata-only alert delivery and avoids
recursion for alert delivery failures. Inspect `delivery_kind=dead_letter_alert`
when diagnosing the alert path.

## Rate limits

The default limiter uses an atomic Redis Lua token bucket with Redis server
`TIME`. `maxRequests` is the initial burst capacity; an empty bucket refills
continuously to that capacity over `windowSeconds` without further consumption.
There is no fixed-window reset.

| Setting                           | Default                                                                    | Meaning                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `RATE_LIMIT_ENABLED`              | `true` outside `NODE_ENV=test`; `false` in tests unless explicitly enabled | Enable rate limiting                                                                                  |
| `RATE_LIMIT_AUTH_MAX_REQUESTS`    | `10`                                                                       | Shared register/login bucket capacity per trusted socket IP                                           |
| `RATE_LIMIT_AUTH_WINDOW_SECONDS`  | `60`                                                                       | Time to refill an empty auth bucket completely                                                        |
| `RATE_LIMIT_EVENT_MAX_REQUESTS`   | `120`                                                                      | Event bucket capacity per authenticated user/project, or socket-IP fallback for unauthorized attempts |
| `RATE_LIMIT_EVENT_WINDOW_SECONDS` | `60`                                                                       | Time to refill an empty event bucket completely                                                       |

All API replicas must connect to the same Redis database (including the logical
DB selected by `REDIS_URL`) and use identical `RATE_LIMIT_*` policies. Configure
policy changes consistently across replicas; mixed policies do not define a
consistent shared quota. `X-Forwarded-For` is not trusted: traffic through a
proxy shares the proxy's socket IP for IP-scoped limits.

`RATE_LIMIT_MAX_ENTRIES` is retired for the Redis limiter. It was a cap on the
old process-local map, not a Redis memory or key-count limit. Bucket keys are
`hookforge:rate-limit:v1:SHA256(scope)`, with a TTL equal to the policy's
`windowSeconds`. Raw scope identifiers are not embedded in the key names.

### Quota exhaustion and Redis failures

- `429 RATE_LIMIT_EXCEEDED` means no token was available. `Retry-After` is the
  number of seconds until the next token, not until the bucket is full or a
  window resets. Tune the explicit policy variables for a controlled benchmark;
  a `429` response does not measure downstream delivery latency.
- `503 RATE_LIMIT_UNAVAILABLE` means Redis was unavailable, returned an error,
  or a command timed out. The limiter fails closed with no local fallback. It
  uses the normal safe error envelope and does not expose Redis error details.
- The Redis client adapter disables offline queuing and bounds command timeout
  to 1 second. These are client failure-handling settings, not Redis persistence
  settings or an end-to-end HTTP request deadline.
- `/health`, `/ready`, and `/metrics` are not rate limited. `/ready` checks
  PostgreSQL and Redis; use it with `docker compose ps` and
  `docker compose logs --tail=100 redis api` to investigate dependency failures.
  A successful Redis `PING` alone does not prove that a bucket update can succeed
  if Redis is rejecting writes.

### Quota lifetime and Redis capacity

Compose configures Redis with `noeviction` and disables persistence. Under
memory pressure Redis can reject bucket writes instead of evicting quotas;
these errors return `503 RATE_LIMIT_UNAVAILABLE`. Inspect Redis memory and
command errors when readiness succeeds but rate-limited requests fail.

Redis restart or flush loses quota state in this setup, so new buckets start
with full burst capacity. Shared atomic decisions do not provide durable quota
guarantees through restart or failover. PostgreSQL remains the durable delivery
queue: losing Redis quota state does not remove accepted events or deliveries.

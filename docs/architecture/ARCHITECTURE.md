# HookForge architecture

## Scope

HookForge starts as a modular monolith with independently started API and
worker processes. Both processes share typed modules and SQL migrations, while
PostgreSQL remains the authoritative store for all durable delivery state.

The repository currently implements service health, readiness, runtime metrics,
authentication, project ownership, endpoint lifecycle management, event
persistence, idempotency, durable delivery scheduling, worker delivery, and
delivery inspection/replay APIs.

## Components

- **API**: validates authenticated project operations, persists events, and
  returns an acknowledgement after the database transaction commits.
- **Worker**: claims due deliveries from PostgreSQL, performs bounded outbound
  HTTP requests, records attempts, and schedules retries.
- **PostgreSQL**: source of truth for users, projects, endpoints, events,
  current delivery state, attempt history, and idempotency keys.
- **Redis**: shared, ephemeral token bucket state for API rate limits. Redis
  failures block rate-limited requests with `503`; losing quota state does not
  lose an accepted event or delivery from PostgreSQL.
- **Web**: React dashboard that calls the versioned API; it contains no durable
  business state of its own.

Authentication currently uses PostgreSQL-backed opaque bearer sessions. User
passwords are scrypt hashes, session tokens are stored only as SHA-256 hashes,
and every project/endpoint query scopes through the authenticated owner.

Endpoint signing secrets are generated in Node.js and encrypted with
AES-256-GCM before being stored in `endpoint_secrets`. The plaintext is returned
only on endpoint creation or explicit rotation. A current secret version is
kept separately from retired versions so future delivery can select a stable
configuration.

When `ENVELOPE_PROVIDER=vault`, AES-256-GCM uses a versioned data-encryption key
whose wrapped form is stored in `encryption_key_versions`. HashiCorp Vault
Transit protects the data key; API and worker processes cache an unwrapped key
only briefly. New key versions become active without invalidating queued
delivery snapshots, and secret/key operations are written to `audit_events`
without plaintext credentials.

## Distributed rate limiting

The default API limiter uses a Redis Lua script to atomically refill and consume
tokens using Redis server `TIME`. `maxRequests` sets initial burst capacity and
the upper bound on stored tokens. Refill is continuous at
`maxRequests / windowSeconds` tokens per second, so an empty bucket becomes full
over `windowSeconds` without further consumption. There is no fixed-window
reset, and API host clocks do not determine refill timing.

Registration and login share an auth scope per trusted socket IP. Event
ingestion uses an authenticated user/project scope, with a separate socket-IP
fallback for unauthorized attempts. `X-Forwarded-For` is not trusted. Redis keys
are `hookforge:rate-limit:v1:SHA256(scope)` and have a TTL equal to the policy's
`windowSeconds`.

Quota exhaustion returns `429 RATE_LIMIT_EXCEEDED` and `Retry-After` in seconds
until the next token. Redis unavailability, errors, or timeouts return
`503 RATE_LIMIT_UNAVAILABLE` in the safe error envelope; there is no local
fallback. The Redis adapter disables offline queuing and uses a bounded
1-second command timeout. `/health`, `/ready`, and `/metrics` are not rate
limited; readiness checks Redis as well as PostgreSQL.

Compose uses `noeviction` and disables Redis persistence. Restart or flush loses
quotas, and there is no durable quota guarantee through restart or failover.
Client timeout/queuing settings do not change that persistence policy.
PostgreSQL remains the durable delivery queue.

## Retention and monthly archives

The hot `events`, `deliveries`, and `delivery_attempts` tables preserve their
existing UUID/FK contracts for queue compatibility. A daily retention runner
copies complete terminal event graphs into `hookforge_archive.events`,
`hookforge_archive.deliveries`, and `hookforge_archive.delivery_attempts`.
Each archive parent is declaratively `PARTITION BY RANGE (created_at)` with
UTC monthly child tables (`delivery_attempts.created_at` is the attempt's
`request_at`). Only after the graph is copied are hot attempts, deliveries,
idempotency rows, and events removed. Older archive child tables are dropped as
whole months, avoiding an unbounded append-only hot queue. A PostgreSQL
advisory lock makes concurrent runner instances safe.

`InMemoryRateLimiter` remains only as an explicitly injected test double;
rate limiting is disabled by default under `NODE_ENV=test`. The old map's
`RATE_LIMIT_MAX_ENTRIES` setting is retired for the Redis limiter. See
[ADR 0012](decisions/0012-distributed-redis-rate-limiting.md) for the decision
superseding ADR 0010's process-local limits.

## Queue and transaction boundary

The delivery queue is a PostgreSQL-backed table. Event ingestion locks the owned
project row, then inserts the event, its idempotency record, and one delivery
row per active endpoint in a single transaction. Each delivery snapshots the
endpoint URL and secret version so later endpoint edits do not alter already
accepted work. The worker scans a bounded due batch and claims a row using a
short transaction and `FOR UPDATE SKIP LOCKED`. Before claiming, it locks
project and endpoint quota mutex rows and counts durable `in_flight` rows, so
per-endpoint and per-project caps hold across worker processes. A second
transaction records the attempt and either marks the delivery terminal or
assigns its next due time.

This removes the database/queue dual-write problem: a committed event always
has durable delivery rows. It also avoids requiring a second durable queue
implementation on a resource-constrained laptop. Redis is not used as a
delivery queue.

Idempotency keys are scoped to a project and store a SHA-256 fingerprint of the
event type plus canonical payload. A repeated matching request returns the
original event and delivery count; a mismatched request is rejected. Project
row locking serializes concurrent idempotency checks for the same project while
keeping unrelated projects independent.

## Delivery guarantees

The target guarantee is **at least once**. A process can crash after an HTTP
receiver accepts a request but before the attempt transaction commits. Lease
recovery may then send the same event again. Every delivery includes a stable
event ID, and receiver applications must deduplicate side effects using that
ID. HookForge will not claim exactly-once HTTP delivery.

## Failure handling

Leased work has a bounded lease duration. A recovery query returns expired
leases to the due state. Network failures, timeouts, `408`, `429`, and selected
`5xx` responses are retryable subject to policy; most other `4xx` responses are
terminal. Retry timing uses capped exponential backoff with bounded jitter and
an upper-bounded `Retry-After` value.

The worker increments the durable attempt count when claiming a row. A process
crash after claiming leaves the row leased until expiration; the next claim
returns it to `pending` and can deliver it again. Every completed HTTP attempt
is stored in `delivery_attempts`, including response status, bounded excerpt,
duration, classification, and outcome.

Replay never resets an existing delivery. It creates a new delivery with the
same event and endpoint, links it through `replay_of_delivery_id`, increments
the per-event/endpoint replay number, and snapshots the endpoint's current
configuration. This keeps original attempts auditable and prevents replay from
mutating historical results.

The API exposes safe operational metrics from in-process request counters and
PostgreSQL aggregates. JSON `/metrics` remains a debugging snapshot while
`/metrics/prometheus` and the worker's internal `/metrics` listener provide
standard Prometheus exposition. A worker writes a PostgreSQL heartbeat every few seconds;
the worker container health check verifies a fresh active heartbeat. Heartbeat
state is operational liveness, not delivery truth: delivery leases and attempt
rows remain authoritative if a worker disappears.

Outbound requests use a deadline, disable redirects by default, bound response
body reads, and validate the endpoint again at delivery time to reduce SSRF
risk. The worker pins the validated address into the socket lookup while
retaining the configured hostname for HTTP Host and TLS SNI/certificate
validation. Requests sign `timestamp + "." + raw_body` with HMAC-SHA256 and include
the stable event ID and timestamp headers. An OpenTelemetry ingestion span's
W3C context is persisted with the event, restored by the worker after the
PostgreSQL claim, and propagated through a child receiver HTTP span. No signing
secret, authorization header, or payload is logged by default.

## Scaling considerations

The default Compose deployment uses one API process and one worker. API replicas
share rate-limit quotas only when they use the same Redis database and identical
`RATE_LIMIT_*` policies. This coordinates quotas while Redis state is available;
it does not establish Redis high availability or durable quotas across failover.

Worker concurrency is bounded, and PostgreSQL connection pools are small. More
workers can be added later because row locks and leases prevent concurrent
claims of the same delivery. The first bottlenecks to measure are the delivery
table indexes, endpoint latency, and PostgreSQL write volume from attempt
history.

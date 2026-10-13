# HookForge architecture

## Scope

HookForge starts as a modular monolith with independently started API and
worker processes. Both processes share typed modules and SQL migrations, while
PostgreSQL remains the authoritative store for all durable delivery state.

The repository currently implements service health, readiness, runtime metrics,
authentication, project ownership, endpoint lifecycle management, and the
initial domain schema. Event persistence and delivery flows below describe the
accepted next milestones.

## Components

- **API**: validates authenticated project operations, persists events, and
  returns an acknowledgement after the database transaction commits.
- **Worker**: claims due deliveries from PostgreSQL, performs bounded outbound
  HTTP requests, records attempts, and schedules retries.
- **PostgreSQL**: source of truth for users, projects, endpoints, events,
  current delivery state, attempt history, and idempotency keys.
- **Redis**: short-lived rate-limit counters and coordination state. Losing
  Redis must not lose an event or delivery.
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

## Queue and transaction boundary

The delivery queue is a PostgreSQL-backed table. Event ingestion inserts the
event, its idempotency record, and one delivery row per eligible endpoint in a
single transaction. A worker claims a due row using a short transaction and
`FOR UPDATE SKIP LOCKED`, sets a lease, and commits before making the outbound
request. A second transaction records the attempt and either marks the
delivery terminal or assigns its next due time.

This removes the database/queue dual-write problem: a committed event always
has durable delivery rows. It also avoids requiring a second durable queue
implementation on a resource-constrained laptop. Redis is not used as a
delivery queue.

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

Outbound requests use a deadline, disable redirects by default, bound response
body reads, and validate the endpoint again at delivery time to reduce SSRF
risk. No signing secret, authorization header, or payload is logged by default.

## Scaling considerations

The first deployment uses one API process and one worker. Worker concurrency is
bounded, and PostgreSQL connection pools are small. More workers can be added
later because row locks and leases prevent concurrent claims of the same
delivery. The first bottlenecks to measure are the delivery table indexes,
endpoint latency, and PostgreSQL write volume from attempt history.

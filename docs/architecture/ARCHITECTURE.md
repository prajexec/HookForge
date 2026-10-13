# HookForge architecture

## Scope

HookForge starts as a modular monolith with independently started API and
worker processes. Both processes share typed modules and SQL migrations, while
PostgreSQL remains the authoritative store for all durable delivery state.

The repository currently implements service health, readiness, runtime metrics,
authentication, project ownership, endpoint lifecycle management, event
persistence, idempotency, durable delivery scheduling, and the initial worker
delivery path. Delivery inspection and replay APIs remain later milestones.

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

The delivery queue is a PostgreSQL-backed table. Event ingestion locks the owned
project row, then inserts the event, its idempotency record, and one delivery
row per active endpoint in a single transaction. Each delivery snapshots the
endpoint URL and secret version so later endpoint edits do not alter already
accepted work. The worker claims a due row using a short transaction and
`FOR UPDATE SKIP LOCKED`, sets a lease, and commits before making the outbound
request. A second transaction records the attempt and either marks the
delivery terminal or assigns its next due time.

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

Outbound requests use a deadline, disable redirects by default, bound response
body reads, and validate the endpoint again at delivery time to reduce SSRF
risk. Requests sign `timestamp + "." + raw_body` with HMAC-SHA256 and include
the stable event ID and timestamp headers. No signing secret, authorization
header, or payload is logged by default.

## Scaling considerations

The first deployment uses one API process and one worker. Worker concurrency is
bounded, and PostgreSQL connection pools are small. More workers can be added
later because row locks and leases prevent concurrent claims of the same
delivery. The first bottlenecks to measure are the delivery table indexes,
endpoint latency, and PostgreSQL write volume from attempt history.

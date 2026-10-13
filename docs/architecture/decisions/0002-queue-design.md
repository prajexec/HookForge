# ADR 0002: PostgreSQL-backed delivery queue

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

An event must not be acknowledged when its durable delivery work could be lost
between a PostgreSQL commit and a separate queue publish. The local setup also
needs to stay small.

## Alternatives considered

- BullMQ backed by Redis.
- A transactional outbox plus a Redis/BullMQ publisher.
- A PostgreSQL delivery table claimed with `FOR UPDATE SKIP LOCKED`.

## Decision

Use a PostgreSQL-backed delivery queue. Event, idempotency, and initial
delivery rows will be inserted in one transaction. Workers will claim due rows
with short leases and row locks. Redis remains available for ephemeral state
and rate limiting, but is not a delivery queue.

## Consequences

The source of truth and scheduling state are co-located, and a separate
publisher process is unnecessary. PostgreSQL receives queue polling and
attempt-history writes, so indexes, bounded concurrency, and query measurements
are important. This design is intentionally sufficient for the initial
single-instance deployment; a dedicated queue can be reconsidered only after
measured database pressure.

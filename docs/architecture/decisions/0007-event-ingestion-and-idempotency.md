# ADR 0007: Transactional event ingestion and project-scoped idempotency

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

An accepted event must not be left without durable delivery work if a queue
publish or process step fails. Clients also retry requests when network
responses are lost, so the API needs a safe way to avoid duplicate event fan-out.

## Alternatives considered

- A separate Redis queue published after committing the event.
- A transactional outbox followed by a publisher process.
- A PostgreSQL event and delivery table written in one transaction.

## Decision

Use PostgreSQL as both the source of truth and initial durable queue. Ingestion
locks the authenticated project row, verifies ownership, checks a
project-scoped `Idempotency-Key`, inserts the event, records the request hash,
selects active endpoints, snapshots their URL and secret version, and inserts
pending deliveries before commit. The API returns `202` only after that
transaction commits.

The request hash is SHA-256 over the event type and recursively key-sorted JSON
payload. A matching key returns the original event with `200`; a different
request using the same key returns `409`.

## Consequences

Accepted events and initial delivery work cannot be split by a process crash.
Project-row locking serializes ingestion and idempotency checks for one project,
which is a deliberate simple starting point and a workload to measure before
optimizing. Endpoint pause/resume state is evaluated at ingestion time, and
configuration snapshots keep later endpoint edits from changing already-created
delivery work. A future worker can claim pending rows with `SKIP LOCKED`.

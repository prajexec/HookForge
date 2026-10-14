# ADR 0010: Lightweight metrics, process-local limits, and worker heartbeats

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

HookForge needs actionable local operations data without adding Prometheus,
Grafana, or another stateful service. Sensitive routes also need basic abuse
protection, and a worker process must be distinguishable from a worker that has
stopped making progress.

## Decision

Keep JSON `/metrics` as the initial observability surface. Record request counts,
durations, response statuses, sanitized error codes, event-loop lag, queue
backlog, delivery status/latency aggregates, and fresh worker heartbeat state.
Persist worker heartbeats in PostgreSQL, where delivery state already lives;
Compose checks a fresh active heartbeat and restarts a stale worker.

Use a bounded process-local fixed-window limiter for authentication and event
ingestion. Defaults are 10 auth requests per IP per 60 seconds and 120 event
requests per user/project per 60 seconds. Redis remains available for future
shared coordination, but rate-limit correctness is not made dependent on Redis.

## Consequences

The system stays small and inspectable on the development laptop. JSON metrics
are not a replacement for a production metrics backend, and process-local rate
limits do not coordinate across API replicas. PostgreSQL heartbeat writes add a
small periodic write load but make worker liveness observable without another
service. k6 scripts provide reproducible workloads; numbers are recorded only
when actually measured.

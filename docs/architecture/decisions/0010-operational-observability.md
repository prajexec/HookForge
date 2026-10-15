# ADR 0010: Lightweight metrics, process-local limits, and worker heartbeats

- **Status:** Accepted; rate-limiting decision superseded by
  [ADR 0012](0012-distributed-redis-rate-limiting.md)
- **Date:** 2026-10-13

The process-local rate-limiting decision and its consequences below are
historical. ADR 0012 replaces them with shared Redis token buckets and
fail-closed Redis dependency handling. The metrics and worker-heartbeat
decisions remain in effect.

## Context

HookForge needs actionable local operations data without adding Prometheus,
Grafana, or another stateful service. Sensitive routes also need basic abuse
protection, and a worker process must be distinguishable from a worker that has
stopped making progress.

## Decision

Keep JSON `/metrics` as a local debugging surface and add
`/metrics/prometheus` using `prom-client` for standard scraping. The worker
also exposes an internal Prometheus listener. Record request counts, durations,
response statuses, sanitized error codes, event-loop lag, queue backlog,
delivery status/latency aggregates, and fresh worker heartbeat state.
Persist worker heartbeats in PostgreSQL, where delivery state already lives;
Compose checks a fresh active heartbeat and restarts a stale worker.

Use OpenTelemetry W3C propagation for the API ingestion span, the durable
PostgreSQL queue boundary, the worker delivery span, and the receiver HTTP
span. Persist `traceparent`/`tracestate` with the event because process-local
context cannot cross a database queue.

Use a bounded process-local fixed-window limiter for authentication and event
ingestion. Defaults are 10 auth requests per IP per 60 seconds and 120 event
requests per user/project per 60 seconds. Redis remains available for future
shared coordination, but rate-limit correctness is not made dependent on Redis.

## Consequences

The system stays small and inspectable on the development laptop. JSON metrics
are not a replacement for a production metrics backend, and Prometheus scraping
still requires a collector and retention policy. Process-local rate limits do
not coordinate across API replicas. PostgreSQL heartbeat writes add a small
periodic write load but make worker liveness observable without another service.
k6 scripts provide reproducible workloads; numbers are recorded only when
actually measured.

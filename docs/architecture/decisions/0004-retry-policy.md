# ADR 0004: Capped backoff with jitter

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

Transient network failures and overloaded receivers should be retried without
creating synchronized retry storms.

## Decision

Use configurable capped exponential backoff with bounded random jitter. Network
errors, timeouts, `408`, `429`, and selected `5xx` responses are retryable.
`Retry-After` may override the calculated delay only within a configured cap.
Most other `4xx` responses are terminal. Every attempt is recorded.

## Consequences

Retry scheduling is durable in PostgreSQL and does not require a sleeping
worker per delayed delivery. The current defaults are a 1-second initial delay,
1-hour cap, 20% bounded jitter, and 8 maximum attempts. `Retry-After` is
honored within the configured cap.

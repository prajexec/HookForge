# ADR 0004: Capped backoff with jitter

- **Status:** Accepted policy; implementation pending
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
worker per delayed delivery. The exact defaults will be committed with the
worker implementation and covered by deterministic unit tests.

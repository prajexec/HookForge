# ADR 0012: Distributed Redis token bucket rate limiting

- **Status:** Accepted
- **Date:** 2026-10-15
- **Supersedes:** The rate-limiting decision in
  [ADR 0010](0010-operational-observability.md)

## Context

ADR 0010 chose bounded process-local fixed-window limits. Each API replica had
its own quota, so adding replicas multiplied the allowance, and process-local
state could not coordinate concurrent requests across replicas. Redis is
already a dependency for ephemeral coordination. Authentication and event
ingestion need shared quotas without moving the durable delivery queue out of
PostgreSQL.

## Decision

Use a Redis token bucket as the default rate limiter. A Lua script atomically
refills and consumes tokens using Redis server `TIME`, rather than API host
clocks. `maxRequests` defines the initial burst capacity and maximum stored
tokens. Refill is continuous at `maxRequests / windowSeconds` tokens per second;
without further consumption, an empty bucket refills fully over
`windowSeconds`. This replaces fixed-window reset semantics.

Keep the existing route scopes:

- Registration and login share one auth bucket per trusted socket IP, with a
  default capacity of 10 and full refill over 60 seconds.
- Event ingestion uses the authenticated user/project pair, with a separate
  socket-IP fallback for unauthorized attempts, a default capacity of 120, and
  full refill over 60 seconds.
- `X-Forwarded-For` is not trusted. `/health`, `/ready`, and `/metrics` are not
  rate limited; readiness continues to check Redis and PostgreSQL.

All API replicas must use the same Redis database and identical `RATE_LIMIT_*`
policies. Store buckets under `hookforge:rate-limit:v1:SHA256(scope)` with a TTL
equal to the policy's `windowSeconds`. The key namespace is versioned, and raw
scope identifiers are not embedded in key names.

Return `429 RATE_LIMIT_EXCEEDED` when no token is available, with `Retry-After`
in seconds until the next token rather than a full-window reset. Redis
unavailability, command errors, and timeouts return `503 RATE_LIMIT_UNAVAILABLE`
through the safe error envelope without exposing Redis internals. There is no
process-local fallback. The Redis client adapter disables offline queuing and
uses a bounded 1-second command timeout.

Retire `RATE_LIMIT_MAX_ENTRIES`, which bounded the former production map. Keep
`InMemoryRateLimiter` only as an explicitly injected test double. Rate limiting
remains disabled by default under `NODE_ENV=test`; enabling it does not select
an automatic in-memory fallback.

## Consequences

Concurrent requests share a quota across replicas while the shared Redis state
is available. The policy permits an initial burst plus continuous refill, not
a strict count within every fixed or rolling window. Mixed Redis databases or
policy values break the shared-quota assumption.

Redis is now required to admit rate-limited requests. Client timeout and
offline-queue settings bound command failure handling; they do not configure
Redis persistence or guarantee an end-to-end HTTP deadline.

The existing Compose Redis service uses `noeviction` and has persistence
disabled. Memory pressure can reject bucket updates, which fail closed with
`503`. Restart or flush loses quotas, and this decision makes no durable quota
guarantee through restart or failover. TTL-based cleanup does not cap the total
number of active scopes. PostgreSQL remains the durable delivery queue, so
losing quota state does not delete accepted events or delivery work.

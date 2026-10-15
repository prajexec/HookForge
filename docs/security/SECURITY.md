# Security notes

## Current foundation

- Environment values are validated at startup with Zod.
- Fastify request IDs and structured logs are enabled.
- Helmet security headers and an explicit local CORS origin are configured.
- Health and metrics responses do not include credentials, URLs, payloads, or
  dependency error text.
- `.env` and generated artifacts are ignored by Git.
- Passwords use asynchronous Node.js `scrypt`; bearer session tokens are
  persisted only as SHA-256 hashes and can be revoked.
- Endpoint signing secrets use AES-256-GCM encryption at rest and are returned
  only during creation or rotation.
- Custom endpoint headers are encrypted with the same AES-256-GCM key; only
  header names are returned. Generated content type, user-agent, and
  `x-hookforge-*` integrity headers cannot be overridden.
- Project and endpoint queries require an authenticated owner predicate; an
  object belonging to another user is returned as `404`.
- Endpoint URL registration and update reject non-HTTP(S) schemes, credentials,
  fragments, blocked hostnames, and DNS resolutions into private address ranges.
- Event bodies are bounded by Fastify's request limit and the configured
  `MAX_EVENT_PAYLOAD_BYTES` limit; idempotency fingerprints prevent accidental
  duplicate fan-out when clients retry an accepted request.
- The worker revalidates endpoint DNS and blocked address ranges before every
  attempt, pins the validated address into the Node socket lookup while
  retaining the hostname for HTTP Host/TLS SNI, disables redirects, applies
  request deadlines, and bounds response body reads. HMAC signatures use
  constant-time verification in the helper and include a timestamp tolerance
  for receiver-side replay protection.
- Delivery inspection, replay, and reconciliation queries are scoped through
  the authenticated project owner. Replay preserves history and does not allow
  a caller to submit an arbitrary event or endpoint ID.
- Bulk replay and cancellation are bounded to 100 explicit IDs and require an
  idempotency key. Cancellation of an in-flight delivery only takes effect
  after the current request completes; it cannot retract an HTTP request already
  accepted by a receiver.
- The dashboard keeps bearer tokens in React memory only, sends them over the
  relative same-origin API path, omits credentials/cookies, and never stores or
  logs signing secrets. A production deployment should serve the web app and
  API behind the same trusted origin or configure an explicit secure proxy.
- Registration, login, and event ingestion use distributed Redis token buckets.
  Atomic Lua consumption and Redis server `TIME` coordinate quotas across API
  replicas sharing the same Redis database and `RATE_LIMIT_*` policies.
- Docker build contexts exclude `.env`, host `node_modules`, build output, and
  logs. Runtime images contain only compiled application output and production
  dependencies; local Compose defaults use a known development key and must not
  be used as production secrets.

## Envelope encryption and audit trail

`ENVELOPE_PROVIDER=legacy` retains the local AES-256-GCM development path. For
production, `ENVELOPE_PROVIDER=vault` uses HashiCorp Vault Transit to wrap a
random 32-byte data-encryption key. HookForge stores only the Vault ciphertext
in `encryption_key_versions`; endpoint secrets and static headers contain the
key-version reference and AES-GCM ciphertext. Plaintext data keys are cached
only in process memory for `ENVELOPE_KEY_CACHE_TTL_SECONDS`.

`npm run db:rotate-encryption-key` marks the active version as `retiring` and
creates a new Vault-wrapped version. New writes use the new version while
workers continue to unwrap old versions, so rotation does not interrupt queued
deliveries. Keep the legacy environment key until legacy rows have been
rewrapped. Vault Transit audit devices should be enabled separately; HookForge
also records key creation and endpoint secret/header operations in
`audit_events` without storing plaintext secrets, payloads, or provider tokens.

## Retention and trace data

The retention runner archives complete terminal event graphs into monthly
declarative RANGE partitions under `hookforge_archive` before deleting hot
rows. It uses a PostgreSQL advisory lock, bounded batches, UTC boundaries, and
refuses pending or in-flight graphs. Archive and purge settings are controlled
by `ARCHIVE_AFTER_MONTHS`, `PURGE_AFTER_MONTHS`, and `RETENTION_BATCH_SIZE`;
`RETENTION_DRY_RUN=true` does not delete data.

W3C trace context is persisted with accepted events so a PostgreSQL queue does
not sever distributed traces. Worker and receiver spans contain correlation
IDs, while Prometheus labels deliberately exclude project, endpoint, event,
request, URL, and payload values to avoid cardinality and disclosure risks.

## Rate-limit boundary

Registration and login share an auth bucket per trusted socket IP. Event
ingestion uses the authenticated user/project pair; unauthorized attempts fall
back to a separate socket-IP scope. `X-Forwarded-For` is not trusted, so proxy
traffic shares the proxy's socket IP for IP-scoped quotas. These limits cover
the named routes, not every API operation. `/health`, `/ready`, and `/metrics`
are not rate limited, and readiness checks Redis.

`maxRequests` is a burst capacity, refilled continuously over `windowSeconds`;
it is not a strict fixed-window request cap. Exhaustion returns
`429 RATE_LIMIT_EXCEEDED` with `Retry-After` in seconds until the next token.
Redis unavailability, errors, and command timeouts fail closed with
`503 RATE_LIMIT_UNAVAILABLE`, a safe error envelope, and no local fallback.
The Redis adapter disables offline queuing and uses a 1-second command timeout.

Bucket keys use `hookforge:rate-limit:v1:SHA256(scope)` with a policy-window TTL,
so key names do not contain raw IP, user, or project identifiers. Compose uses
`noeviction` with Redis persistence disabled; restart or flush loses quotas,
and there is no durable quota guarantee through restart or failover.
PostgreSQL still holds durable events and delivery work. See the
[runbook](../operations/RUNBOOK.md#rate-limits).

## Local sandbox boundary

The built-in mock receiver is bounded, in-memory, and published on loopback by
Compose. Sandbox captures omit authorization and cookie headers. The API only
proxies capture inspection for endpoint URLs it created from the configured
sandbox receiver; it is not an arbitrary URL proxy. `ALLOW_PRIVATE_ENDPOINTS`
is enabled by the default development Compose profile solely so the worker can
reach `mock-receiver` on the private Compose network and must remain disabled in
production.

Outbound delivery is an SSRF boundary. Endpoint registration and every delivery
must validate URL schemes, resolve hostnames, reject loopback, private,
link-local, and cloud-metadata ranges by default, revalidate DNS at send time,
pin the validated result to the outgoing socket, revalidate every redirect hop,
and disable redirects unless explicitly made safe. The sandbox uses an opaque
high-entropy token in its receiver path and should not be published beyond
localhost.

Dead-letter alerts are signed webhook deliveries to an endpoint owned by the
same project. Alert payloads include delivery metadata, not the original event
payload, and alert deliveries do not recursively generate more alerts.

At-least-once delivery means a receiver can see a duplicate request. Receivers
must verify the timestamped HMAC and deduplicate event IDs before performing
non-idempotent side effects.

## Reporting

Do not commit credentials or real signing secrets. Report suspected security
issues privately to the repository maintainer rather than opening a public issue
with exploit details.

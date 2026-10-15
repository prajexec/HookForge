# HookForge API

The API is versioned under `/api/v1` for domain routes. Operational endpoints
remain unversioned because they are consumed by orchestrators rather than
project clients.

## Implemented routes

### `GET /health`

Returns `200` when the API process is alive. It intentionally does not disclose
database, Redis, or internal error details.

```json
{
  "status": "ok",
  "service": "hookforge-api"
}
```

### `GET /ready`

Checks PostgreSQL with `SELECT 1` and Redis with `PING`. Returns `200` when both
are available and `503` otherwise.

```json
{
  "status": "ready",
  "checks": {
    "database": "ok",
    "redis": "ok"
  }
}
```

The error state uses `"status": "not_ready"` and reports only `"ok"` or
`"error"` per dependency.

### `GET /openapi.json`

Returns the versioned OpenAPI 3.1 contract for every implemented route. The
checked-in artifact is [openapi.json](./openapi.json), and CI fails if it does
not match the source contract. Regenerate it after an API route or response
change with:

```bash
npm run openapi:generate
```

### `GET /metrics`

Returns a small JSON snapshot containing HTTP request counters, process memory
and uptime, event-loop lag, request duration aggregates, response status counts,
sanitized error-code counts, queue backlog/status counts, delivery latency
aggregates, and worker heartbeat/concurrency state. It contains no endpoint
URLs, payloads, or credentials.

### Prometheus scraping

`GET /metrics` with an `Accept: text/plain` header, or `GET /metrics/prometheus`,
returns process/runtime counters in Prometheus text exposition format with a
`text/plain; version=0.0.4` content type. Queue and worker gauges are
refreshed from PostgreSQL when available; the scrape remains useful if the
database is temporarily unavailable. Worker instances expose their own
internal-only `GET /metrics` listener on `WORKER_METRICS_PORT` (default 9464).

## Request IDs and errors

Fastify accepts an incoming `X-Request-Id` and generates one when absent. The
ID is returned on every response and in structured application errors and is
available in logs. The
domain error envelope will remain:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Safe human-readable message"
  },
  "requestId": "request-id"
}
```

The complete machine-readable contract is available at `/openapi.json`. It
documents bearer authentication, request and response schemas, pagination,
idempotency behavior, rate-limit responses, and the safe error envelope. No
unimplemented route is presented as available.

When OpenTelemetry is enabled, event ingestion stores W3C `traceparent` and
`tracestate` alongside the event. The worker restores that context after the
PostgreSQL queue claim and propagates a child trace to the receiver request.

## Rate limits

The default rate limiter is a distributed Redis token bucket. Each bucket starts
with `maxRequests` tokens, consumes one token per admitted request, and refills
continuously at `maxRequests / windowSeconds` tokens per second, capped at
`maxRequests`. An empty bucket refills completely over `windowSeconds` without
further consumption. This is an initial burst plus a sustained refill rate, not
a fixed-window reset or a strict request count in every rolling window.

| Routes                                                     | Bucket scope                                                                                | Default capacity | Default refill                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------- |
| `POST /api/v1/auth/register` and `POST /api/v1/auth/login` | One shared auth bucket per trusted socket IP                                                | 10 tokens        | 10 tokens over 60 seconds (one every 6 seconds) |
| `POST /api/v1/projects/{projectId}/events`                 | Authenticated user + project; unauthorized attempts fall back to a separate socket-IP scope | 120 tokens       | 120 tokens over 60 seconds (2 per second)       |

The client IP comes from the socket, not `X-Forwarded-For`. Requests arriving
through a proxy therefore share its socket IP for IP-scoped limits. All API
replicas must use the same Redis database and matching `RATE_LIMIT_*` policies
to share quotas. Consumption and refill are atomic in Redis Lua and use Redis
server `TIME`, avoiding API-replica clock differences.

| Condition                                    | Response                     | Client guidance                                                                    |
| -------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------- |
| No token available                           | `429 RATE_LIMIT_EXCEEDED`    | `Retry-After` gives seconds until the next token, not until a whole window resets. |
| Redis unavailable, command error, or timeout | `503 RATE_LIMIT_UNAVAILABLE` | The quota could not be checked; this is not a quota-exhaustion response.           |

Both failures use the [safe error envelope](#request-ids-and-errors), including
`requestId`, without exposing Redis connection details or internal errors. The
limiter fails closed with no process-local fallback. `/health`, `/ready`, and
`/metrics` are not rate limited; `/ready` still checks Redis availability.

Quota state is ephemeral: Redis restart or flush loses quotas in the current
Compose setup, and restart/failover continuity is not guaranteed. See the
[runbook](../operations/RUNBOOK.md#rate-limits) for configuration and operations.

## Authentication

Authentication uses PostgreSQL-backed opaque bearer sessions. Registration and
login return a token once; send it on subsequent requests as:

```text
Authorization: Bearer <token>
```

Raw tokens are hashed before persistence. Sessions expire according to
`SESSION_TTL_SECONDS` and can be revoked with logout. Passwords must be at
least 12 characters and are stored with Node.js `scrypt` hashes. The current
API does not use browser cookies, so mutation routes do not require a CSRF
token.

## Implemented authentication and project routes

### `POST /api/v1/auth/register`

Accepts `{ "email": "dev@example.com", "password": "..." }` and returns
`201` with a user, bearer token, and expiration. Duplicate emails return `409`.
Registration and login share the [auth token bucket](#rate-limits) for the
trusted socket IP: a default burst of 10 requests, refilling continuously over
60 seconds. Rate-limit failures return `429 RATE_LIMIT_EXCEEDED` or
`503 RATE_LIMIT_UNAVAILABLE` as described above.

### `POST /api/v1/auth/login`

Accepts the same credentials and returns a new session. Invalid credentials
return the same generic `401` response regardless of whether the email exists.

### `GET /api/v1/auth/me` and `POST /api/v1/auth/logout`

Both require a bearer token. `me` returns the current user; logout revokes the
current session and returns `204`.

### `POST /api/v1/projects`

Creates a project from `{ "name": "Payments" }`. Ownership is derived from
the authenticated session, never from request input.

### `GET /api/v1/projects` and `GET /api/v1/projects/{projectId}`

List and retrieve only projects owned by the authenticated user. The list
supports `?limit=1..100` and defaults to 50. An inaccessible project is
reported as `404`.

## Implemented endpoint routes

- `POST /api/v1/projects/{projectId}/endpoints` — create `{name,url}`, optional
  `eventPatterns`, and encrypted static `headers`; return the signing secret
  once.
- `GET /api/v1/projects/{projectId}/endpoints` — list owned endpoints with a
  `limit` query parameter.
- `GET /api/v1/projects/{projectId}/endpoints/{endpointId}` — retrieve an
  endpoint without its secret.
- `PATCH /api/v1/projects/{projectId}/endpoints/{endpointId}` — update name or
  URL, with the same SSRF policy as creation.
- `POST .../{endpointId}/pause` and `POST .../{endpointId}/resume` — change
  delivery eligibility.
- `POST .../{endpointId}/rotate-secret` — atomically create a new encrypted
  secret version and return the new plaintext once.
- `DELETE .../{endpointId}` — safely disables the endpoint and preserves its
  record for future delivery history.
- `GET` and `PUT` `.../{endpointId}/subscriptions` — inspect or replace exact
  event types and terminal-wildcard patterns such as `payment.*`. An empty
  pattern list opts the endpoint out of future events.

Endpoint list/detail responses never include a signing secret. URL validation
allows only HTTP(S), rejects credentials and fragments, blocks local/private,
link-local, and metadata addresses by default, and resolves hostnames before
accepting them. `ALLOW_PRIVATE_ENDPOINTS=true` is an explicit local-only
escape hatch for a controlled test environment and must not be used in
production.

Endpoint lists are currently bounded to the first 100 records and use local
dashboard search. Delivery and event lists use opaque keyset cursors.

Static header values are encrypted at rest and are never returned; endpoint
responses expose only `staticHeaderNames`. Header snapshots are copied into
queued deliveries so editing an endpoint does not change work already accepted.
HookForge-generated integrity headers cannot be overridden.

## Event ingestion

### `POST /api/v1/projects/{projectId}/events`

Requires a bearer token and accepts:

```json
{
  "eventType": "payment.created",
  "payload": {
    "paymentId": "pay_123",
    "amount": 1250
  }
}
```

The payload must be valid JSON and is limited by `MAX_EVENT_PAYLOAD_BYTES`
(128 KiB by default). The API persists the event and creates one `pending`
delivery row for every active endpoint whose subscription matches the event.
Paused, disabled, and non-matching endpoints are not scheduled. The response is
`202 Accepted` and does not wait for an HTTP receiver.

Send an optional `Idempotency-Key` header to safely retry ingestion. The key is
scoped to the project and the request fingerprint includes `eventType` and a
canonical JSON representation of `payload`. Repeating the same key and request
returns `200` with the original event ID and `deduplicated: true`. Reusing a key
with a different request returns `409 IDEMPOTENCY_KEY_REUSED`. Requests without
the header always create a new event.

The transaction locks the owned project row, inserts the event, records the
idempotency key when present, snapshots active endpoint URLs and secret versions,
and inserts delivery rows before committing. A committed accepted event
therefore cannot be acknowledged without its durable initial delivery work.

Event ingestion uses the shared Redis [event token bucket](#rate-limits) for
the authenticated user/project pair: a default burst of 120 requests, refilling
continuously over 60 seconds. Unauthorized attempts use the socket-IP fallback
scope. Quota exhaustion returns `429 RATE_LIMIT_EXCEEDED`; Redis failures return
`503 RATE_LIMIT_UNAVAILABLE`.

The standalone worker claims those pending rows asynchronously. Delivery
inspection and replay routes are described below.

## Delivery inspection and replay

### `GET /api/v1/projects/{projectId}/deliveries`

Returns a bounded keyset-paginated list of deliveries owned by the authenticated
user. Supported query parameters are:

- `limit` — 1 through 100, default 25
- `cursor` — opaque cursor returned by the previous response
- `status` — `pending`, `in_flight`, `delivered`, `failed`, or `cancelled`
- `kind` — `event` or `dead_letter_alert`; normal lists default to `event`
- `endpointId` — filter by endpoint UUID
- `eventType` — filter by exact event type
- `from` and `to` — ISO-8601 creation-time range; `to` is exclusive

The response includes `pagination.nextCursor`, or `null` at the end. Delivery
rows include attempt count, current status, last HTTP status/error, endpoint
snapshot, and replay metadata. Signing secrets are never included.

### `GET /api/v1/projects/{projectId}/deliveries/{deliveryId}`

Returns one authorized delivery, its event payload, and the complete ordered
attempt history. An inaccessible or unknown delivery returns `404`.

### `POST /api/v1/projects/{projectId}/deliveries/{deliveryId}/replay`

Only a terminally failed delivery can be replayed. The API creates a separate
pending delivery row, preserves the original attempt history, and snapshots the
endpoint's current URL and secret version. The endpoint must currently be
active. The response is `202 Accepted` with `replayNumber` and the source
delivery ID. Replaying a pending, in-flight, or delivered delivery returns
`409`.

### Bulk replay and cancellation

`POST .../deliveries/bulk-replay` and `POST .../deliveries/bulk-cancel` accept up
to 100 explicit `deliveryIds` and require an `Idempotency-Key`. Replays preserve
source rows and return per-ID skipped reasons. Cancellation changes pending rows
to `cancelled` and marks in-flight rows for cancellation after their current
attempt. A completed request cannot be retracted from a receiver.

### `POST /api/v1/projects/{projectId}/deliveries/reconcile`

Returns expired in-flight deliveries for that project to `pending` and clears
their leases. The worker performs the same recovery automatically while
claiming; this route is an explicit operational reconciliation tool.

## Sandbox and dead-letter alerts

`POST /api/v1/projects/{projectId}/sandbox/endpoints` creates a normal signed
endpoint targeting the Compose `mock-receiver` and returns a one-time signing
secret plus its browser-accessible public URL. The capture proxy routes are
`GET` and `DELETE` at
`.../{endpointId}/sandbox/requests`. Captures are bounded and ephemeral; the
receiver is exposed on loopback at `http://localhost:8080` by default.

Configure signed dead-letter alerting with `GET`, `PUT`, and `DELETE`
`/api/v1/projects/{projectId}/alerts/dead-letter`. The destination must be an
owned non-disabled endpoint. Terminal event failures create one metadata-only
`dead_letter_alert` delivery and never recursively alert on alert failures.

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

### `GET /metrics`

Returns a small JSON snapshot containing HTTP request counters, process memory
and uptime, and event-loop lag. It contains no endpoint URLs, payloads, or
credentials. A Prometheus exposition endpoint can be added if measured needs
justify it.

## Request IDs and errors

Fastify accepts an incoming `X-Request-Id` and generates one when absent. The
ID is returned in structured application errors and is available in logs. The
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

Cursor pagination, rate limits, and OpenAPI generation will be expanded as those
features are implemented. No unimplemented route is presented as available.

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

- `POST /api/v1/projects/{projectId}/endpoints` — create `{name,url}` and
  return the signing secret once.
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

Endpoint list/detail responses never include a signing secret. URL validation
allows only HTTP(S), rejects credentials and fragments, blocks local/private,
link-local, and metadata addresses by default, and resolves hostnames before
accepting them. `ALLOW_PRIVATE_ENDPOINTS=true` is an explicit local-only
escape hatch for a controlled test environment and must not be used in
production.

Pagination is currently bounded-limit only; cursor pagination will be added
with delivery inspection once those tables exist.

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
delivery row for every endpoint that is active at commit time. Paused and
disabled endpoints are not scheduled. The response is `202 Accepted` and does
not wait for an HTTP receiver.

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

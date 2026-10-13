# HookForge API

The API is versioned under `/api/v1` for domain routes. The foundation
milestone currently exposes only unversioned operational endpoints because they
are consumed by orchestrators rather than project clients.

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

Authentication, project routes, idempotency headers, pagination, rate limits,
and OpenAPI generation will be documented when those routes are implemented.
No unimplemented route is presented as available.

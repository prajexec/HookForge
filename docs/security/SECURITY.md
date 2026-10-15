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
  attempt, disables redirects, applies request deadlines, and bounds response
  body reads. HMAC signatures use constant-time verification in the helper and
  include a timestamp tolerance for receiver-side replay protection.
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
- Sensitive authentication and event-ingestion routes use bounded fixed-window
  rate limits. The limiter is intentionally process-local for the single API
  deployment; it is not a substitute for a shared distributed limiter when
  scaling out.
- Docker build contexts exclude `.env`, host `node_modules`, build output, and
  logs. Runtime images contain only compiled application output and production
  dependencies; local Compose defaults use a known development key and must not
  be used as production secrets.

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
revalidate every redirect hop, and disable redirects unless explicitly made
safe. The sandbox uses an opaque high-entropy token in its receiver path and
should not be published beyond localhost.

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

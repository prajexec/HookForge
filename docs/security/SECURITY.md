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
- Project and endpoint queries require an authenticated owner predicate; an
  object belonging to another user is returned as `404`.
- Endpoint URL registration and update reject non-HTTP(S) schemes, credentials,
  fragments, blocked hostnames, and DNS resolutions into private address ranges.
- Event bodies are bounded by Fastify's request limit and the configured
  `MAX_EVENT_PAYLOAD_BYTES` limit; idempotency fingerprints prevent accidental
  duplicate fan-out when clients retry an accepted request.

## Planned security boundaries

The domain milestones still need login rate limiting, event payload limits,
constant-time HMAC comparison for delivery, and full response redaction across
future delivery diagnostics. Current SQL access is parameterized and endpoint
secrets are encrypted, but the master encryption key must be supplied through a
secret manager in production.

Outbound delivery is an SSRF boundary. Endpoint registration and every delivery
must validate URL schemes, resolve hostnames, reject loopback, private,
link-local, and cloud-metadata ranges by default, revalidate DNS at send time,
revalidate every redirect hop, and disable redirects unless explicitly made
safe. The local receiver example will use an explicit test configuration rather
than turning the API into an unrestricted proxy.

At-least-once delivery means a receiver can see a duplicate request. Receivers
must verify the timestamped HMAC and deduplicate event IDs before performing
non-idempotent side effects.

## Reporting

Do not commit credentials or real signing secrets. Report suspected security
issues privately to the repository maintainer rather than opening a public issue
with exploit details.

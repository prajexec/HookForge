# Security notes

## Current foundation

- Environment values are validated at startup with Zod.
- Fastify request IDs and structured logs are enabled.
- Helmet security headers and an explicit local CORS origin are configured.
- Health and metrics responses do not include credentials, URLs, payloads, or
  dependency error text.
- `.env` and generated artifacts are ignored by Git.

## Planned security boundaries

The domain milestones must implement password hashing or another documented
authentication mechanism, project-level authorization on every resource query,
parameterized SQL, rate limits, payload limits, constant-time HMAC comparison,
secret rotation, and response redaction.

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

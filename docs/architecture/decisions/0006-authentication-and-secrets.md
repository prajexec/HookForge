# ADR 0006: Opaque sessions and encrypted endpoint secrets

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

The API needs authentication and must later retrieve webhook signing secrets for
outbound HMAC requests. A browser cookie would require CSRF handling and a JWT
would make revocation and key rotation more complicated for this small system.

## Alternatives considered

- Stateless JWT access tokens.
- Browser cookies with a cookie plugin and CSRF tokens.
- PostgreSQL-backed opaque bearer sessions.
- Hashing endpoint signing secrets, which would prevent future delivery.

## Decision

Use asynchronous Node.js `scrypt` for passwords and generate high-entropy opaque
bearer tokens. Store only SHA-256 token hashes in PostgreSQL with expiration and
revocation fields. The initial API sends tokens in the `Authorization` header.
Generate endpoint signing secrets with `randomBytes` and encrypt them using
AES-256-GCM with a 32-byte application key. Store current and retired secret
versions in a separate table and return plaintext only on creation or rotation.

## Consequences

Sessions are immediately revocable and do not depend on Redis persistence. A
database lookup occurs for each authenticated request, which is appropriate for
the initial single API instance. The encryption key must be protected outside
the repository and rotated with an explicit key-versioning migration in a later
operations milestone. If the dashboard later adopts cookies, CSRF protection
and credentialed CORS must be added before doing so.

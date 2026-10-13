# Changelog

## Unreleased

### Added

- Initialized the TypeScript npm workspace for API, worker, web, and shared
  packages.
- Added Fastify liveness, dependency readiness, and lightweight metrics routes.
- Added ARM64-conscious PostgreSQL and Redis Compose services.
- Added the transactional SQL migration runner and initial `pgcrypto` migration.
- Added foundation architecture, security, operations, and development docs.
- Added users, sessions, projects, endpoints, encrypted signing-secret versions,
  and tenant-scoped APIs.
- Added scrypt password hashing, opaque bearer authentication, SSRF-aware URL
  validation, endpoint lifecycle actions, and 20 automated tests.
- Added event ingestion with canonical idempotency keys, payload limits, active
  endpoint fan-out, endpoint configuration snapshots, and durable delivery rows.
- Added the delivery worker with PostgreSQL leases, HMAC-SHA256 signatures,
  bounded HTTP requests, retry classification/backoff, response excerpts, and
  abandoned-lease recovery.
- Added paginated delivery inspection, attempt-history detail, project-scoped
  replay, and expired-lease reconciliation APIs.
- Added the API-backed React dashboard with in-memory authentication, project
  creation, event publishing, endpoint controls, delivery filtering, attempt
  detail, and replay actions.

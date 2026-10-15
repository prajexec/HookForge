# ADR 0011: Routing, local sandbox, and DLQ operations

## Status

Accepted

## Context

Initial HookForge fan-out scheduled every active endpoint for every event. That
was predictable but forced projects to provision separate receiver services for
testing and provided no safe operator workflow for a large failed-delivery
backlog. Static receiver headers, event subscriptions, bulk lifecycle actions,
and dead-letter alerts were also missing.

## Decision

- Endpoints own a bounded list of exact event patterns and terminal-wildcard
  patterns (`payment.created`, `payment.*`, or `*`). Matching uses `EXISTS` so
  multiple matching patterns still create one delivery.
- Custom static header values are encrypted with the existing AES-256-GCM key.
  Header names are visible; values are not returned. URL, secret version,
  headers, and routing decisions are snapshotted into each delivery.
- Compose includes a loopback-only, bounded, in-memory `mock-receiver`. The API
  creates normal signed sandbox endpoints and proxies only their tokenized
  capture routes. Captures are intentionally ephemeral.
- Bulk replay and cancellation accept explicit, bounded ID lists and an
  idempotency key. Pending rows become `cancelled`; in-flight rows finish their
  current attempt before cancellation. Replay never mutates its source row.
- A project may select an owned endpoint for dead-letter alerts. A terminal
  event failure records DLQ metadata and creates one signed metadata-only alert
  delivery. Alert deliveries do not generate recursive alerts.

## Consequences

Queued work keeps the configuration that was accepted with the event, while
replays intentionally use the endpoint's current URL, secret, and headers.
This avoids surprising changes to already accepted work and lets operators
rotate endpoint configuration before replaying. The system remains at-least
once: cancellation cannot retract a request already sent to a receiver.

The mock receiver must not be exposed publicly or used as durable storage. A
future external alert transport can be added without changing the delivery
state machine because alerting is already represented as a delivery kind.

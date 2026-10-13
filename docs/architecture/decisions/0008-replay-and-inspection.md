# ADR 0008: Auditable delivery inspection and separate replay rows

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

Operators need to inspect delivery state and attempt history without exposing
other projects. Manual replay must not erase the evidence explaining why the
original delivery failed.

## Alternatives considered

- Reset the existing failed delivery to `pending` and reuse its attempt count.
- Create a new event for every replay.
- Create a separate delivery row linked to the original delivery.

## Decision

Use keyset-paginated, owner-scoped delivery queries and a separate delivery row
for every replay. A replay is allowed only for a terminally failed source and
an active endpoint. It references the source through `replay_of_delivery_id`,
gets the next per-event/endpoint `replay_number`, and snapshots the endpoint's
current URL and secret version. The source and all of its attempts remain
unchanged.

## Consequences

Replay history is explicit and each replay has an independent attempt sequence.
The delivery table grows with manual replays, so retention policies must account
for replay rows and their attempts. Keyset pagination remains stable under new
deliveries and avoids large offsets for the dashboard.

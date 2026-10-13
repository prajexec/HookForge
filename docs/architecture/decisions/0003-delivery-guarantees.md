# ADR 0003: At-least-once delivery

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

HTTP receivers can accept a request while a worker is crashing. No local
transaction can atomically commit PostgreSQL state and a remote receiver's
side effect.

## Decision

HookForge provides at-least-once delivery with stable event IDs. A lease may be
recovered and sent again after a worker crash. Receiver integrations must make
side effects idempotent using the event ID, and the documentation will include
the duplicate-delivery scenario.

## Consequences

The system favors not losing accepted work over avoiding duplicate requests.
Attempt history and explicit delivery states make duplicates observable. True
exactly-once HTTP delivery is not promised.

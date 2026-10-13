# ADR 0005: Versioned HMAC signature header

- **Status:** Accepted policy; implementation pending
- **Date:** 2026-10-13

## Context

Receivers need to authenticate the exact bytes HookForge sends and reject old
captured requests.

## Decision

The worker will sign `timestamp + "." + raw_body` with HMAC-SHA256 and send
`X-HookForge-Event-Id`, `X-HookForge-Timestamp`, and
`X-HookForge-Signature: v1=<hex_signature>`. Verification will use a timestamp
tolerance and constant-time comparison. Secret rotation will support current
and previous verification secrets during an explicit overlap window.

## Consequences

The raw body must never be parsed and reserialized before signing. The format
is independently implementable, versioned, and resistant to simple replay when
receivers enforce the timestamp tolerance.

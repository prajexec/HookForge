# Architecture diagrams

The solid foundation components are implemented now. Dashed nodes and flows
are the accepted delivery milestones and are intentionally marked as future
until their code lands.

## High-level component architecture

```mermaid
flowchart LR
  Browser[React dashboard] --> API[Fastify API]
  API --> PG[(PostgreSQL source of truth)]
  API --> Redis[(Redis ephemeral state)]
  Worker[Delivery worker - future] --> PG
  Worker --> Receiver[Customer webhook receiver - future]
  Web[Static web app] -. serves .-> Browser
```

## Event ingestion sequence

```mermaid
sequenceDiagram
  participant C as Client
  participant A as API
  participant P as PostgreSQL
  participant W as Worker
  participant R as Receiver
  Note over A: Event and initial delivery rows commit atomically
  C->>A: POST /api/v1/projects/{id}/events
  A->>P: BEGIN; insert idempotency key, event, deliveries
  P-->>A: COMMIT
  A-->>C: 202 Accepted with event ID
  W->>P: Claim due delivery
  W->>R: Signed HTTP POST
```

## Delivery worker sequence

```mermaid
sequenceDiagram
  participant W as Worker
  participant P as PostgreSQL
  participant R as Receiver
  Note over W,R: Future delivery milestone
  W->>P: Claim row with SKIP LOCKED and lease
  W->>R: POST raw body with signature
  alt Success
    R-->>W: 2xx
    W->>P: Record attempt and mark delivered
  else Retryable failure
    R-->>W: timeout, 408, 429, or 5xx
    W->>P: Record attempt and set next_attempt_at
  else Terminal failure
    R-->>W: Most 4xx responses
    W->>P: Record attempt and mark failed
  end
```

## Retry state machine

```mermaid
stateDiagram-v2
  [*] --> Pending
  Pending --> InFlight: worker claims lease
  InFlight --> Delivered: 2xx
  InFlight --> Pending: retryable failure and attempts remain
  InFlight --> Failed: terminal failure or attempts exhausted
  InFlight --> Pending: lease expires after worker crash
  Delivered --> [*]
  Failed --> [*]
```

## Database entity relationships

```mermaid
erDiagram
  USERS ||--o{ PROJECTS : owns
  PROJECTS ||--o{ ENDPOINTS : registers
  PROJECTS ||--o{ EVENTS : receives
  EVENTS ||--o{ DELIVERIES : fans_out_to
  ENDPOINTS ||--o{ DELIVERIES : receives
  DELIVERIES ||--o{ DELIVERY_ATTEMPTS : records
```

The entities are part of the accepted target schema and will be introduced by
the domain-schema milestone.

## Failure recovery and abandoned jobs

```mermaid
flowchart TD
  Claim[Claim due delivery and set lease] --> Request[Send bounded HTTP request]
  Request --> Commit[Record attempt transaction]
  Claim -. worker crashes .-> Expired[Lease expires]
  Expired --> Reconcile[Recovery query finds expired lease]
  Reconcile --> Claim
  Commit --> Done[Delivered or next retry time]
```

## Deployment architecture

```mermaid
flowchart TB
  subgraph DockerCompose[Local Docker Compose on ARM64]
    API[API process - future image]
    Worker[Worker process - future image]
    PG[(PostgreSQL 16 Alpine)]
    Redis[(Redis 7 Alpine)]
    Web[Frontend - future image]
  end
  API --> PG
  API --> Redis
  Worker --> PG
  Web --> API
  Worker --> Internet[Configured webhook endpoints]
```

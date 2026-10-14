# HookForge API benchmarks

This directory contains a small [k6](https://grafana.com/docs/k6/latest/)
harness for the API. It measures three named workloads in one run so event
ingestion can be distinguished from operational and project reads:

- `event_ingestion` — `POST /api/v1/projects/{projectId}/events`
- `health_read` — `GET /health`
- `overview_read` — `GET /api/v1/projects/{projectId}/overview`

The scenarios use constant VUs and run concurrently. Each custom latency Trend
is emitted separately as `event_ingestion_latency`, `health_read_latency`, or
`overview_read_latency`; k6 also reports the standard request metrics by
scenario. The default checks only assert successful responses, with a 1%
failed-request and 1% failed-check budget. They are starting guardrails, not
claims about a production SLO, and no latency target is asserted by default.

## Setup

Install k6 separately from npm, start the API and its backing services, and use
a dedicated authenticated user and project for the run. `AUTH_TOKEN` is the
opaque bearer token returned by registration or login, and `PROJECT_ID` is the
project UUID.

For a throughput-focused ingestion run, raise the local event limit above the
expected request count or explicitly disable the process-local limiter for that
controlled local run. Otherwise, `429` responses measure rate-limit behavior,
not ingestion capacity:

```bash
RATE_LIMIT_EVENT_MAX_REQUESTS=100000 docker compose up -d api worker web
```

Do not use that setting as a production default.

The repository's local Compose setup serves the API at
`http://localhost:3000`. For example:

```bash
BASE_URL=http://localhost:3000 \
AUTH_TOKEN=replace-with-a-session-token \
PROJECT_ID=replace-with-a-project-uuid \
npm run bench
```

Configuration variables:

| Variable     | Default                 | Description                                                |
| ------------ | ----------------------- | ---------------------------------------------------------- |
| `BASE_URL`   | `http://localhost:3000` | API origin, without a required trailing slash              |
| `AUTH_TOKEN` | required                | Bearer session token for ingestion and overview            |
| `PROJECT_ID` | required                | Owned project UUID used by the authenticated routes        |
| `VUS`        | `10`                    | Constant VUs per scenario; start with 10–25 for local runs |
| `DURATION`   | `15s`                   | Duration of each scenario                                  |

For example, a larger starting point is:

```bash
BASE_URL=http://localhost:3000 AUTH_TOKEN="$AUTH_TOKEN" \
PROJECT_ID="$PROJECT_ID" VUS=25 DURATION=30s npm run bench
```

## Data expectations

Use a fresh or otherwise dedicated local project. Every ingestion iteration
persists a new event, and active endpoints also create delivery work; this data
is intentionally left behind so the result reflects the real write path. For a
low-noise local baseline, use a project with no active endpoints and reset or
remove the benchmark project between materially different runs. Existing
events, deliveries, worker activity, and database cache state can affect later
runs.

## Measured and unmeasured results

The k6 summary is the measured result for the exact `BASE_URL`, data state,
`VUS`, `DURATION`, application revision, and machine used. Record those inputs
with any exported summary; this repository does not include fabricated latency
or throughput numbers.

This harness does not measure webhook receiver latency, end-to-end delivery
completion, browser/dashboard performance, a production traffic mix, or a
controlled database/Redis resource ceiling. Those require separate workloads
and environment instrumentation. k6 was not installed in the baseline
development environment for this milestone, so no benchmark numbers are claimed
here.

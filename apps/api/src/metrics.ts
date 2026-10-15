import { monitorEventLoopDelay } from "node:perf_hooks";

import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";

import type { OperationalMetrics } from "./store.js";

export interface MetricsSnapshot {
  counters: Record<string, number>;
  requestDurationMilliseconds: {
    count: number;
    total: number;
    minimum: number;
    maximum: number;
    average: number;
  };
  responseStatusCodes: Record<string, number>;
  errors: Record<string, number>;
  process: {
    uptimeSeconds: number;
    rssBytes: number;
    heapUsedBytes: number;
  };
  eventLoopLagMilliseconds: number | null;
}

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly responseStatusCodes = new Map<number, number>();
  private readonly errors = new Map<string, number>();
  private requestDurationCount = 0;
  private requestDurationTotal = 0;
  private requestDurationMinimum = Number.POSITIVE_INFINITY;
  private requestDurationMaximum = 0;
  private readonly eventLoop = monitorEventLoopDelay({ resolution: 20 });
  public readonly registry = new Registry();
  private readonly promCounters = new Map<string, Counter<string>>();
  private readonly httpResponses: Counter<string>;
  private readonly httpDuration: Histogram<string>;
  private readonly httpErrors: Counter<string>;
  private readonly queueDepth: Gauge<string>;
  private readonly workerGauge: Gauge<string>;

  public constructor() {
    this.eventLoop.enable();
    collectDefaultMetrics({ register: this.registry, prefix: "hookforge_" });
    this.httpResponses = new Counter({
      name: "hookforge_http_responses_total",
      help: "HTTP responses returned by the API",
      labelNames: ["status"],
      registers: [this.registry],
    });
    this.httpDuration = new Histogram({
      name: "hookforge_http_request_duration_seconds",
      help: "HTTP request duration in seconds",
      labelNames: ["method", "route"],
      registers: [this.registry],
    });
    this.httpErrors = new Counter({
      name: "hookforge_http_errors_total",
      help: "HTTP errors grouped by sanitized application code",
      labelNames: ["code"],
      registers: [this.registry],
    });
    this.queueDepth = new Gauge({
      name: "hookforge_queue_depth",
      help: "Current PostgreSQL queue depth",
      labelNames: ["state"],
      registers: [this.registry],
    });
    this.workerGauge = new Gauge({
      name: "hookforge_workers",
      help: "Current worker state counts",
      labelNames: ["state"],
      registers: [this.registry],
    });
    for (const name of [
      "http_requests_total",
      "events_accepted_total",
      "events_deduplicated_total",
      "deliveries_scheduled_total",
      "delivery_replays_total",
    ]) {
      this.promCounters.set(
        name,
        new Counter({
          name: `hookforge_${name}`,
          help: `HookForge ${name.replaceAll("_", " ")}`,
          registers: [this.registry],
        }),
      );
    }
  }

  public increment(name: string, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
    const prometheusName = name
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .toLowerCase();
    this.promCounters.get(prometheusName)?.inc(value);
  }

  public recordResponse(
    statusCode: number,
    durationMilliseconds: number,
    method = "unknown",
    route = "unknown",
  ): void {
    const duration = Math.max(
      0,
      Number.isFinite(durationMilliseconds) ? durationMilliseconds : 0,
    );
    this.requestDurationCount += 1;
    this.requestDurationTotal += duration;
    this.requestDurationMinimum = Math.min(
      this.requestDurationMinimum,
      duration,
    );
    this.requestDurationMaximum = Math.max(
      this.requestDurationMaximum,
      duration,
    );
    this.responseStatusCodes.set(
      statusCode,
      (this.responseStatusCodes.get(statusCode) ?? 0) + 1,
    );

    this.increment("httpResponsesTotal");
    this.increment(`httpStatus${statusCode}Total`);
    if (statusCode >= 400) {
      this.increment("httpErrorsTotal");
      this.increment(
        statusCode >= 500 ? "httpServerErrorsTotal" : "httpClientErrorsTotal",
      );
    }
    this.increment("httpRequestDurationCount");
    this.increment("httpRequestDurationMillisecondsTotal", duration);
    this.httpResponses.labels(String(statusCode)).inc();
    this.httpDuration.labels(method, route).observe(duration / 1_000);
  }

  public recordError(code: string): void {
    const safeCode = /^[A-Za-z0-9_.-]{1,64}$/.test(code)
      ? code
      : "UNKNOWN_ERROR";
    this.errors.set(safeCode, (this.errors.get(safeCode) ?? 0) + 1);
    this.increment("httpErrorsByCodeTotal");
    this.httpErrors.labels(safeCode).inc();
  }

  public setOperationalMetrics(value: OperationalMetrics): void {
    this.queueDepth.labels("pending").set(value.queueBacklog.pending);
    this.queueDepth.labels("in_flight").set(value.queueBacklog.inFlight);
    this.workerGauge.labels("active").set(value.workers.active);
    this.workerGauge.labels("stale").set(value.workers.stale);
    this.workerGauge.labels("active_jobs").set(value.workers.activeJobs);
  }

  public prometheus(): Promise<string> {
    return this.registry.metrics();
  }

  public snapshot(): MetricsSnapshot {
    const memory = process.memoryUsage();
    const eventLoopLagMilliseconds = Number.isFinite(this.eventLoop.mean)
      ? this.eventLoop.mean / 1_000_000
      : null;

    return {
      counters: Object.fromEntries(this.counters.entries()),
      requestDurationMilliseconds: {
        count: this.requestDurationCount,
        total: this.requestDurationTotal,
        minimum:
          this.requestDurationCount === 0 ? 0 : this.requestDurationMinimum,
        maximum: this.requestDurationMaximum,
        average:
          this.requestDurationCount === 0
            ? 0
            : this.requestDurationTotal / this.requestDurationCount,
      },
      responseStatusCodes: Object.fromEntries(
        [...this.responseStatusCodes.entries()].map(([status, count]) => [
          String(status),
          count,
        ]),
      ),
      errors: Object.fromEntries(this.errors.entries()),
      process: {
        uptimeSeconds: process.uptime(),
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
      },
      eventLoopLagMilliseconds,
    };
  }

  public stop(): void {
    this.eventLoop.disable();
  }
}

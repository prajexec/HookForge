import { monitorEventLoopDelay } from "node:perf_hooks";

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

  public constructor() {
    this.eventLoop.enable();
  }

  public increment(name: string, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  public recordResponse(
    statusCode: number,
    durationMilliseconds: number,
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
  }

  public recordError(code: string): void {
    const safeCode = /^[A-Za-z0-9_.-]{1,64}$/.test(code)
      ? code
      : "UNKNOWN_ERROR";
    this.errors.set(safeCode, (this.errors.get(safeCode) ?? 0) + 1);
    this.increment("httpErrorsByCodeTotal");
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

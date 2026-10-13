import { monitorEventLoopDelay } from "node:perf_hooks";

export interface MetricsSnapshot {
  counters: Record<string, number>;
  process: {
    uptimeSeconds: number;
    rssBytes: number;
    heapUsedBytes: number;
  };
  eventLoopLagMilliseconds: number | null;
}

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly eventLoop = monitorEventLoopDelay({ resolution: 20 });

  public constructor() {
    this.eventLoop.enable();
  }

  public increment(name: string, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  public snapshot(): MetricsSnapshot {
    const memory = process.memoryUsage();
    const eventLoopLagMilliseconds = Number.isFinite(this.eventLoop.mean)
      ? this.eventLoop.mean / 1_000_000
      : null;

    return {
      counters: Object.fromEntries(this.counters.entries()),
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

import type { WorkerConfig } from "./config.js";
import {
  type DeliveryAttemptInput,
  type DeliveryStore,
  LeaseLostError,
} from "./delivery-store.js";
import { deliverJob } from "./delivery.js";
import { calculateBackoffDelay, parseRetryAfter } from "./retry.js";

export interface WorkerLogger {
  info(bindings: object, message: string): void;
  warn(bindings: object, message: string): void;
  error(bindings: object, message: string): void;
}

const defaultLogger: WorkerLogger = {
  info: (bindings, message) =>
    console.info(JSON.stringify({ level: "info", message, ...bindings })),
  warn: (bindings, message) =>
    console.warn(JSON.stringify({ level: "warn", message, ...bindings })),
  error: (bindings, message) =>
    console.error(JSON.stringify({ level: "error", message, ...bindings })),
};

interface WorkerOptions {
  store: DeliveryStore;
  config: WorkerConfig;
  fetchImpl?: typeof fetch;
  logger?: WorkerLogger;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}

export class DeliveryWorker {
  private stopping = false;
  private activeJobs = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private readonly logger: WorkerLogger;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;

  public constructor(private readonly options: WorkerOptions) {
    this.logger = options.logger ?? defaultLogger;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
  }

  public stop(): void {
    this.stopping = true;
  }

  public async start(): Promise<void> {
    this.stopping = false;
    await this.writeHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.writeHeartbeat().catch((error: unknown) => {
        this.logger.error(
          {
            error: error instanceof Error ? error.message : "heartbeat_failed",
          },
          "Worker heartbeat failed",
        );
      });
    }, this.options.config.WORKER_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
    try {
      await Promise.all(
        Array.from({ length: this.options.config.WORKER_CONCURRENCY }, () =>
          this.runLoop(),
        ),
      );
    } finally {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
      await this.options.store.stopHeartbeat(this.options.config.WORKER_ID);
    }
  }

  public async runOnce(): Promise<boolean> {
    const config = this.options.config;
    this.activeJobs += 1;
    try {
      const job = await this.options.store.claimDueDelivery(
        config.WORKER_LEASE_SECONDS,
      );
      if (!job) return false;

      const result = await deliverJob(job, {
        encryptionKey: config.SECRET_ENCRYPTION_KEY,
        allowPrivateEndpoints: config.ALLOW_PRIVATE_ENDPOINTS,
        requestTimeoutMs: config.WORKER_REQUEST_TIMEOUT_MS,
        maxResponseBytes: config.MAX_RESPONSE_BYTES,
        ...(this.options.fetchImpl
          ? { fetchImpl: this.options.fetchImpl }
          : {}),
      });

      let outcome = result.outcome;
      let classification = result.errorClassification;
      let lastError = result.lastError;
      let nextAttemptAt: Date | null = null;
      if (outcome === "retry") {
        if (job.attemptNumber >= config.MAX_DELIVERY_ATTEMPTS) {
          outcome = "failed";
          classification = "max_attempts_exhausted";
          lastError = lastError ?? "Maximum delivery attempts exhausted";
        } else {
          const retryAfter = parseRetryAfter(
            result.retryAfter,
            result.responseAt?.getTime() ?? Date.now(),
            config.RETRY_MAX_DELAY_MS,
          );
          const delay =
            retryAfter ??
            calculateBackoffDelay(
              job.attemptNumber,
              {
                initialDelayMs: config.RETRY_INITIAL_DELAY_MS,
                maxDelayMs: config.RETRY_MAX_DELAY_MS,
                jitterRatio: config.RETRY_JITTER_RATIO,
              },
              this.random(),
            );
          nextAttemptAt = new Date(Date.now() + delay);
        }
      }

      const attempt: DeliveryAttemptInput = {
        job,
        requestAt: result.requestAt,
        responseAt: result.responseAt,
        responseDurationMs: result.responseDurationMs,
        httpStatusCode: result.httpStatusCode,
        responseExcerpt: result.responseExcerpt,
        errorClassification: classification,
        lastError,
        outcome,
        nextAttemptAt,
      };
      await this.options.store.recordAttempt(attempt);

      this.logger.info(
        {
          deliveryId: job.id,
          eventId: job.eventId,
          attempt: job.attemptNumber,
          outcome,
          statusCode: result.httpStatusCode,
        },
        "Delivery attempt recorded",
      );
      return true;
    } finally {
      this.activeJobs -= 1;
    }
  }

  private writeHeartbeat(): Promise<void> {
    return this.options.store.heartbeat({
      workerId: this.options.config.WORKER_ID,
      concurrency: this.options.config.WORKER_CONCURRENCY,
      activeJobs: this.activeJobs,
    });
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const worked = await this.runOnce();
        if (!worked) {
          await this.sleep(this.options.config.WORKER_POLL_INTERVAL_MS);
        }
      } catch (error) {
        if (!(error instanceof LeaseLostError)) {
          this.logger.error(
            { error: error instanceof Error ? error.message : "unknown_error" },
            "Worker loop error",
          );
        }
        await this.sleep(this.options.config.WORKER_POLL_INTERVAL_MS);
      }
    }
  }
}

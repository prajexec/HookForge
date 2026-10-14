import { describe, expect, it } from "vitest";

import type {
  DeliveryAttemptInput,
  DeliveryJob,
  DeliveryStore,
} from "../src/delivery-store.js";
import type { WorkerConfig } from "../src/config.js";
import { DeliveryWorker } from "../src/worker.js";
import { deliveryJob, encryptionKey } from "./fixtures.js";

class FakeDeliveryStore implements DeliveryStore {
  public attempts: DeliveryAttemptInput[] = [];
  public heartbeats: Array<{
    workerId: string;
    concurrency: number;
    activeJobs: number;
  }> = [];
  public stoppedWorkerId: string | null = null;
  private claimed = false;

  public constructor(private readonly job: DeliveryJob) {}

  public async claimDueDelivery(): Promise<DeliveryJob | null> {
    if (this.claimed) return null;
    this.claimed = true;
    return this.job;
  }

  public async recordAttempt(input: DeliveryAttemptInput): Promise<void> {
    this.attempts.push(input);
  }

  public async heartbeat(input: {
    workerId: string;
    concurrency: number;
    activeJobs: number;
  }): Promise<void> {
    this.heartbeats.push(input);
  }

  public async stopHeartbeat(workerId: string): Promise<void> {
    this.stoppedWorkerId = workerId;
  }

  public async close(): Promise<void> {}
}

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    NODE_ENV: "test" as const,
    DATABASE_URL: "postgresql://unused",
    SECRET_ENCRYPTION_KEY: encryptionKey,
    ALLOW_PRIVATE_ENDPOINTS: false,
    WORKER_CONCURRENCY: 1,
    WORKER_POLL_INTERVAL_MS: 25,
    WORKER_LEASE_SECONDS: 60,
    WORKER_REQUEST_TIMEOUT_MS: 1_000,
    MAX_DELIVERY_ATTEMPTS: 3,
    RETRY_INITIAL_DELAY_MS: 1_000,
    RETRY_MAX_DELAY_MS: 10_000,
    RETRY_JITTER_RATIO: 0,
    MAX_RESPONSE_BYTES: 100,
    WORKER_ID: "worker-test",
    WORKER_HEARTBEAT_INTERVAL_MS: 5_000,
    ...overrides,
  };
}

describe("delivery worker", () => {
  it("records retryable HTTP failures with a future schedule", async () => {
    const store = new FakeDeliveryStore(deliveryJob());
    const worker = new DeliveryWorker({
      store,
      config: config(),
      random: () => 0.5,
      fetchImpl: async () => new Response("temporary", { status: 503 }),
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(store.attempts).toHaveLength(1);
    expect(store.attempts[0]).toMatchObject({
      outcome: "retry",
      errorClassification: "http_server_error",
    });
    expect(store.attempts[0]?.nextAttemptAt).toBeInstanceOf(Date);
  });

  it("turns a retryable response into a terminal failure at the attempt limit", async () => {
    const store = new FakeDeliveryStore(deliveryJob({ attemptNumber: 3 }));
    const worker = new DeliveryWorker({
      store,
      config: config(),
      fetchImpl: async () => new Response("temporary", { status: 503 }),
    });

    await worker.runOnce();

    expect(store.attempts[0]).toMatchObject({
      outcome: "failed",
      errorClassification: "max_attempts_exhausted",
    });
    expect(store.attempts[0]?.nextAttemptAt).toBeNull();
  });

  it("publishes a heartbeat while running and marks itself inactive on stop", async () => {
    const store = new FakeDeliveryStore(deliveryJob());
    const worker = new DeliveryWorker({
      store,
      config: config(),
      fetchImpl: async () => new Response("ok", { status: 200 }),
      sleep: async () => worker.stop(),
    });

    await worker.start();

    expect(store.heartbeats[0]).toMatchObject({
      workerId: "worker-test",
      concurrency: 1,
    });
    expect(store.stoppedWorkerId).toBe("worker-test");
  });
});

import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";

export class WorkerMetrics {
  public readonly registry = new Registry();
  public readonly claims = new Counter({
    name: "hookforge_worker_claims_total",
    help: "Delivery claim attempts",
    labelNames: ["result"],
    registers: [this.registry],
  });
  public readonly attempts = new Counter({
    name: "hookforge_worker_delivery_attempts_total",
    help: "Delivery attempts recorded by outcome",
    labelNames: ["outcome", "classification"],
    registers: [this.registry],
  });
  public readonly duration = new Histogram({
    name: "hookforge_worker_delivery_duration_seconds",
    help: "Delivery request duration in seconds",
    labelNames: ["outcome"],
    registers: [this.registry],
  });
  public readonly activeJobs = new Gauge({
    name: "hookforge_worker_active_jobs",
    help: "Currently active worker jobs",
    registers: [this.registry],
  });
  public readonly decryptFailures = new Counter({
    name: "hookforge_worker_decrypt_failures_total",
    help: "Delivery secret or static-header decryption failures",
    registers: [this.registry],
  });

  public constructor() {
    collectDefaultMetrics({
      register: this.registry,
      prefix: "hookforge_worker_",
    });
  }

  public prometheus(): Promise<string> {
    return this.registry.metrics();
  }
}

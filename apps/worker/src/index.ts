import { createServer } from "node:http";

import { parseWorkerConfig } from "./config.js";
import { PgDeliveryStore } from "./delivery-store.js";
import { WorkerMetrics } from "./metrics.js";
import { DeliveryWorker } from "./worker.js";
import { shutdownTelemetry } from "./telemetry.js";

const config = parseWorkerConfig();
const store = new PgDeliveryStore(config.DATABASE_URL, undefined, config);
const metrics = new WorkerMetrics();
const worker = new DeliveryWorker({ store, config, metrics });
const metricsServer = createServer(async (request, response) => {
  if (request.method !== "GET" || request.url !== "/metrics") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": metrics.registry.contentType });
  response.end(await metrics.prometheus());
});
await new Promise<void>((resolve, reject) => {
  metricsServer.once("error", reject);
  metricsServer.listen(
    config.WORKER_METRICS_PORT,
    config.WORKER_METRICS_HOST,
    () => resolve(),
  );
});

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info("HookForge worker stopping");
  worker.stop();
  metricsServer.close();
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await worker.start();
} finally {
  metricsServer.close();
  await store.close();
  await shutdownTelemetry();
}

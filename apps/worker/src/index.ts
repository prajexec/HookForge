import { parseWorkerConfig } from "./config.js";
import { PgDeliveryStore } from "./delivery-store.js";
import { DeliveryWorker } from "./worker.js";

const config = parseWorkerConfig();
const store = new PgDeliveryStore(config.DATABASE_URL);
const worker = new DeliveryWorker({ store, config });

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info("HookForge worker stopping");
  worker.stop();
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await worker.start();
} finally {
  await store.close();
}

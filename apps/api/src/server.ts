import { buildApp } from "./app.js";
import { parseConfig } from "./config.js";
import { createDependencies } from "./dependencies.js";

const config = parseConfig();
const dependencies = createDependencies(config);
const app = await buildApp({ config, dependencies });

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "Shutting down API");
  await app.close();
  await dependencies.close();
};

process.once("SIGINT", () => {
  void shutdown("SIGINT").then(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM").then(() => process.exit(0));
});

try {
  await dependencies.connect();
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error({ err: error }, "API startup failed");
  await app.close();
  await dependencies.close();
  process.exitCode = 1;
}

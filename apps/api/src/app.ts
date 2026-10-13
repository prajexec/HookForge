import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";

import type { AppConfig } from "./config.js";
import type { AppDependencies } from "./dependencies.js";
import { Metrics } from "./metrics.js";

export interface BuildAppOptions {
  config: AppConfig;
  dependencies: AppDependencies;
  logger?: FastifyServerOptions["logger"];
  metrics?: Metrics;
}

export async function buildApp({
  config,
  dependencies,
  logger,
  metrics = new Metrics(),
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger ?? { level: config.LOG_LEVEL },
    requestIdHeader: "x-request-id",
  });

  await app.register(helmet);
  await app.register(cors, {
    origin: config.CORS_ORIGIN === "*" ? true : config.CORS_ORIGIN,
  });

  app.addHook("onRequest", async () => {
    metrics.increment("httpRequestsTotal");
  });

  app.get("/health", async (_request, reply) => {
    return reply.send({
      status: "ok",
      service: "hookforge-api",
    });
  });

  app.get("/ready", async (_request, reply) => {
    const [database, redis] = await Promise.allSettled([
      dependencies.db.query("SELECT 1"),
      dependencies.redis.ping(),
    ]);
    const checks = {
      database: database.status === "fulfilled" ? "ok" : "error",
      redis: redis.status === "fulfilled" ? "ok" : "error",
    } as const;
    const ready = Object.values(checks).every((status) => status === "ok");

    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ready" : "not_ready",
      checks,
    });
  });

  app.get("/metrics", async (_request, reply) => {
    return reply.send(metrics.snapshot());
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "Unhandled request error");

    if (reply.sent) {
      return;
    }

    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    const errorCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "INTERNAL_SERVER_ERROR";
    const errorMessage =
      error instanceof Error ? error.message : "Internal server error";

    return reply.code(statusCode).send({
      error: {
        code: errorCode,
        message: statusCode < 500 ? errorMessage : "Internal server error",
      },
      requestId: request.id,
    });
  });

  app.addHook("onClose", async () => {
    metrics.stop();
  });

  return app;
}

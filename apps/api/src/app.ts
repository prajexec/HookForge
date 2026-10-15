import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";

import type { AppConfig } from "./config.js";
import type { AppDependencies } from "./dependencies.js";
import { AppError } from "./errors.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerAlertRoutes } from "./routes/alerts.js";
import { registerEndpointRoutes } from "./routes/endpoints.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerDeliveryRoutes } from "./routes/deliveries.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerSandboxRoutes } from "./routes/sandbox.js";
import type { EndpointUrlValidator } from "./security/url.js";
import { Metrics } from "./metrics.js";
import { InMemoryRateLimiter, type RateLimiter } from "./rate-limit.js";
import { openApiDocument } from "./openapi.js";

export interface BuildAppOptions {
  config: AppConfig;
  dependencies: AppDependencies;
  logger?: FastifyServerOptions["logger"];
  metrics?: Metrics;
  rateLimiter?: RateLimiter;
  endpointUrlValidator?: EndpointUrlValidator;
}

export async function buildApp({
  config,
  dependencies,
  logger,
  metrics = new Metrics(),
  rateLimiter = config.RATE_LIMIT_ENABLED
    ? new InMemoryRateLimiter({ maxEntries: config.RATE_LIMIT_MAX_ENTRIES })
    : undefined,
  endpointUrlValidator,
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger ?? { level: config.LOG_LEVEL },
    requestIdHeader: "x-request-id",
    bodyLimit: 256 * 1024,
  });

  await app.register(helmet);
  await app.register(cors, {
    origin: config.CORS_ORIGIN === "*" ? true : config.CORS_ORIGIN,
  });

  const requestStartedAt = new WeakMap<object, number>();

  app.addHook("onRequest", async (request) => {
    metrics.increment("httpRequestsTotal");
    requestStartedAt.set(request, performance.now());
  });

  app.addHook("onError", async (_request, _reply, error) => {
    metrics.recordError(errorCode(error));
  });

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.addHook("onResponse", async (request, reply) => {
    metrics.recordResponse(
      reply.statusCode,
      performance.now() - (requestStartedAt.get(request) ?? performance.now()),
      request.method,
      request.routeOptions.url,
    );
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

  app.get("/metrics", async (request, reply) => {
    if (
      typeof request.headers.accept === "string" &&
      request.headers.accept.includes("text/plain")
    ) {
      try {
        metrics.setOperationalMetrics(
          await dependencies.store.getOperationalMetrics(),
        );
      } catch {
        // Runtime counters remain scrapeable while the database is unavailable.
      }
      return reply
        .type(metrics.registry.contentType)
        .send(await metrics.prometheus());
    }
    const [runtime, operational] = await Promise.all([
      Promise.resolve(metrics.snapshot()),
      dependencies.store.getOperationalMetrics(),
    ]);
    return reply.send({ ...runtime, operational });
  });

  app.get("/metrics/prometheus", async (_request, reply) => {
    try {
      metrics.setOperationalMetrics(
        await dependencies.store.getOperationalMetrics(),
      );
    } catch {
      // Runtime counters remain scrapeable while the database is unavailable.
    }
    return reply
      .type(metrics.registry.contentType)
      .send(await metrics.prometheus());
  });

  app.get("/openapi.json", async (_request, reply) => {
    return reply.type("application/json").send(openApiDocument);
  });

  await registerAuthRoutes(app, {
    config,
    store: dependencies.store,
    ...(rateLimiter ? { rateLimiter } : {}),
  });
  await registerProjectRoutes(app, { store: dependencies.store });
  await registerEndpointRoutes(app, {
    config,
    store: dependencies.store,
    ...(dependencies.encryption ? { encryption: dependencies.encryption } : {}),
    ...(endpointUrlValidator ? { urlValidator: endpointUrlValidator } : {}),
  });
  await registerEventRoutes(app, {
    config,
    store: dependencies.store,
    metrics,
    ...(rateLimiter ? { rateLimiter } : {}),
  });
  await registerDeliveryRoutes(app, {
    store: dependencies.store,
    metrics,
  });
  await registerAlertRoutes(app, { store: dependencies.store });
  await registerSandboxRoutes(app, {
    config,
    store: dependencies.store,
    ...(dependencies.encryption ? { encryption: dependencies.encryption } : {}),
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "Unhandled request error");

    if (reply.sent) {
      return;
    }

    const statusCode =
      error instanceof AppError
        ? error.statusCode
        : typeof error === "object" &&
            error !== null &&
            "statusCode" in error &&
            typeof error.statusCode === "number"
          ? error.statusCode
          : 500;
    const errorCode =
      error instanceof AppError
        ? error.code
        : typeof error === "object" &&
            error !== null &&
            "code" in error &&
            typeof error.code === "string"
          ? error.code
          : "INTERNAL_SERVER_ERROR";
    const errorMessage =
      error instanceof AppError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Internal server error";

    if (
      statusCode === 429 &&
      error instanceof AppError &&
      error.retryAfterSeconds !== undefined
    ) {
      reply.header("retry-after", String(error.retryAfterSeconds));
    }

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

function errorCode(error: unknown): string {
  if (error instanceof AppError) {
    return error.code;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "INTERNAL_SERVER_ERROR";
}

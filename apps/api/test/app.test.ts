import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import type { AppDependencies } from "../src/dependencies.js";
import { MemoryStore } from "./support/memory-store.js";

const config = parseConfig({ NODE_ENV: "test" });
const applications: Awaited<ReturnType<typeof buildApp>>[] = [];

function dependencies(
  overrides: Partial<AppDependencies> = {},
): AppDependencies {
  return {
    db: { query: async () => undefined },
    redis: { ping: async () => "PONG" },
    store: new MemoryStore(),
    connect: async () => undefined,
    close: async () => undefined,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    applications.splice(0).map((application) => application.close()),
  );
});

describe("API foundation", () => {
  it("reports liveness without exposing dependency details", async () => {
    const app = await buildApp({
      config,
      dependencies: dependencies(),
      logger: false,
    });
    applications.push(app);

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "hookforge-api" });
  });

  it("reports readiness only when PostgreSQL and Redis respond", async () => {
    const app = await buildApp({
      config,
      dependencies: dependencies(),
      logger: false,
    });
    applications.push(app);

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      checks: { database: "ok", redis: "ok" },
    });
  });

  it("returns 503 when a required dependency is unavailable", async () => {
    const app = await buildApp({
      config,
      dependencies: dependencies({
        db: {
          query: async () => Promise.reject(new Error("database offline")),
        },
      }),
      logger: false,
    });
    applications.push(app);

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "not_ready",
      checks: { database: "error", redis: "ok" },
    });
  });

  it("increments and exposes only non-sensitive runtime metrics", async () => {
    const app = await buildApp({
      config,
      dependencies: dependencies(),
      logger: false,
    });
    applications.push(app);

    await app.inject({ method: "GET", url: "/metrics" });
    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      counters: { httpRequestsTotal: 2 },
    });
    expect(response.json()).toMatchObject({
      responseStatusCodes: { "200": 1 },
      requestDurationMilliseconds: { count: 1 },
      operational: {
        queueBacklog: { pending: 0, inFlight: 0 },
        workers: { active: 0, configuredConcurrency: 0 },
      },
    });
    expect(response.json()).not.toHaveProperty("databaseUrl");

    const completedMetrics = await app.inject({
      method: "GET",
      url: "/metrics",
    });
    expect(completedMetrics.json()).toMatchObject({
      responseStatusCodes: { "200": 2 },
      requestDurationMilliseconds: { count: 2 },
    });
  });

  it("serves the deterministic OpenAPI contract", async () => {
    const app = await buildApp({
      config,
      dependencies: dependencies(),
      logger: false,
    });
    applications.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/openapi.json",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toMatchObject({
      openapi: "3.1.0",
      paths: {
        "/api/v1/projects/{projectId}/events": {
          post: { operationId: "ingestEvent" },
        },
      },
    });
  });

  it("serves standard Prometheus exposition without sensitive values", async () => {
    const app = await buildApp({
      config,
      dependencies: dependencies(),
      logger: false,
    });
    applications.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/metrics/prometheus",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain("hookforge_http_responses_total");
    expect(response.body).not.toContain("databaseUrl");

    const negotiated = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { accept: "text/plain" },
    });
    expect(negotiated.headers["content-type"]).toContain("text/plain");
    expect(negotiated.body).toContain("hookforge_http_responses_total");
  });
});

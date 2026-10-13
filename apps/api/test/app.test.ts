import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import type { AppDependencies } from "../src/dependencies.js";

const config = parseConfig({ NODE_ENV: "test" });
const applications: Awaited<ReturnType<typeof buildApp>>[] = [];

function dependencies(
  overrides: Partial<AppDependencies> = {},
): AppDependencies {
  return {
    db: { query: async () => undefined },
    redis: { ping: async () => "PONG" },
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
    expect(response.json()).not.toHaveProperty("databaseUrl");
  });
});

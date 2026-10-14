import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import type { AppDependencies } from "../src/dependencies.js";
import { InMemoryRateLimiter } from "../src/rate-limit.js";
import { MemoryStore } from "./support/memory-store.js";

const applications: Awaited<ReturnType<typeof buildApp>>[] = [];

function dependencies(store = new MemoryStore()): AppDependencies {
  return {
    db: { query: async () => undefined },
    redis: { ping: async () => "PONG" },
    store,
    connect: async () => undefined,
    close: async () => undefined,
  };
}

function rateLimitedConfig(overrides: Record<string, string> = {}) {
  return parseConfig({
    NODE_ENV: "test",
    RATE_LIMIT_ENABLED: "true",
    RATE_LIMIT_AUTH_MAX_REQUESTS: "10",
    RATE_LIMIT_AUTH_WINDOW_SECONDS: "60",
    RATE_LIMIT_EVENT_MAX_REQUESTS: "120",
    RATE_LIMIT_EVENT_WINDOW_SECONDS: "60",
    ...overrides,
  });
}

async function createApplication(
  config = rateLimitedConfig(),
  store = new MemoryStore(),
) {
  const app = await buildApp({
    config,
    dependencies: dependencies(store),
    endpointUrlValidator: { validate: async (url) => url },
    logger: false,
  });
  applications.push(app);
  return { app, store };
}

async function register(
  app: Awaited<ReturnType<typeof buildApp>>,
  email: string,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    headers,
    payload: { email, password: "correct horse battery staple" },
  });
}

async function createProject(
  app: Awaited<ReturnType<typeof buildApp>>,
  token: string,
  name: string,
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: { authorization: `Bearer ${token}` },
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return response.json().project.id as string;
}

afterEach(async () => {
  await Promise.all(
    applications.splice(0).map((application) => application.close()),
  );
});

describe("bounded in-memory rate limiter", () => {
  it("enforces a window, resets after expiry, and stays bounded", () => {
    let now = 0;
    const limiter = new InMemoryRateLimiter({
      maxEntries: 2,
      now: () => now,
    });
    const rule = { maxRequests: 2, windowSeconds: 10 };

    expect(limiter.consume("client", rule)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    expect(limiter.consume("client", rule)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    expect(limiter.consume("client", rule)).toMatchObject({
      allowed: false,
      retryAfterSeconds: 10,
    });

    now = 10_000;
    expect(limiter.consume("client", rule).allowed).toBe(true);
    limiter.consume("another", rule);
    limiter.consume("overflow", rule);
    expect(limiter.size).toBe(2);
  });

  it("limits login and registration together by the trusted request IP", async () => {
    const { app } = await createApplication(
      rateLimitedConfig({ RATE_LIMIT_AUTH_MAX_REQUESTS: "2" }),
    );

    const first = await register(app, "first@example.com", {
      "x-forwarded-for": "198.51.100.1",
    });
    const second = await register(app, "second@example.com", {
      "x-forwarded-for": "198.51.100.2",
    });
    const blocked = await register(app, "third@example.com");

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toMatch(/^\d+$/);
    expect(blocked.json()).toMatchObject({
      error: {
        code: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests",
      },
    });
    expect(blocked.json()).not.toHaveProperty("password");

    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.json()).toMatchObject({
      responseStatusCodes: { "429": 1 },
      errors: { RATE_LIMIT_EXCEEDED: 1 },
    });
  });

  it("limits event ingestion by authenticated user and project", async () => {
    const { app } = await createApplication(
      rateLimitedConfig({ RATE_LIMIT_EVENT_MAX_REQUESTS: "2" }),
    );
    const registration = await register(app, "events@example.com");
    expect(registration.statusCode).toBe(201);
    const token = registration.json().token as string;
    const firstProjectId = await createProject(app, token, "First");
    const secondProjectId = await createProject(app, token, "Second");
    const headers = { authorization: `Bearer ${token}` };

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${firstProjectId}/events`,
      headers,
      payload: { eventType: "test.one", payload: {} },
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${firstProjectId}/events`,
      headers,
      payload: { eventType: "test.two", payload: {} },
    });
    const blocked = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${firstProjectId}/events`,
      headers,
      payload: { eventType: "test.three", payload: {} },
    });
    const separateProject = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${secondProjectId}/events`,
      headers,
      payload: { eventType: "test.other-project", payload: {} },
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(blocked.statusCode).toBe(429);
    expect(separateProject.statusCode).toBe(202);
    expect(blocked.headers["retry-after"]).toBeDefined();
  });

  it("uses the request IP as the fallback bucket for unauthenticated ingestion", async () => {
    const { app } = await createApplication(
      rateLimitedConfig({ RATE_LIMIT_EVENT_MAX_REQUESTS: "1" }),
    );

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/projects/00000000-0000-4000-8000-000000000001/events",
      headers: { "x-forwarded-for": "198.51.100.10" },
      payload: { eventType: "test.unauthenticated", payload: {} },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/projects/00000000-0000-4000-8000-000000000001/events",
      headers: { "x-forwarded-for": "198.51.100.11" },
      payload: { eventType: "test.unauthenticated", payload: {} },
    });

    expect(first.statusCode).toBe(401);
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("leaves public operational routes available", async () => {
    const { app } = await createApplication(
      rateLimitedConfig({ RATE_LIMIT_AUTH_MAX_REQUESTS: "1" }),
    );

    const health = await app.inject({ method: "GET", url: "/health" });
    const ready = await app.inject({ method: "GET", url: "/ready" });
    const metrics = await app.inject({ method: "GET", url: "/metrics" });

    expect(health.statusCode).toBe(200);
    expect(ready.statusCode).toBe(200);
    expect(metrics.statusCode).toBe(200);
  });
});

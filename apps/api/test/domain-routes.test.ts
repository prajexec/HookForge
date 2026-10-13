import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import type { AppDependencies } from "../src/dependencies.js";
import { MemoryStore } from "./support/memory-store.js";

const config = parseConfig({
  NODE_ENV: "test",
  SECRET_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
});
const applications: Awaited<ReturnType<typeof buildApp>>[] = [];

function dependencies(store: MemoryStore): AppDependencies {
  return {
    db: { query: async () => undefined },
    redis: { ping: async () => "PONG" },
    store,
    connect: async () => undefined,
    close: async () => undefined,
  };
}

async function createApplication(
  store = new MemoryStore(),
  appConfig = config,
) {
  const app = await buildApp({
    config: appConfig,
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
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password: "correct horse battery staple" },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { token: string; user: { id: string } };
}

afterEach(async () => {
  await Promise.all(
    applications.splice(0).map((application) => application.close()),
  );
});

describe("authenticated project and endpoint management", () => {
  it("requires authentication for project operations", async () => {
    const { app } = await createApplication();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "private project" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });

  it("creates projects and isolates them between users", async () => {
    const { app } = await createApplication();
    const firstUser = await register(app, "first@example.com");
    const secondUser = await register(app, "second@example.com");

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${firstUser.token}` },
      payload: { name: "Payments" },
    });
    expect(created.statusCode).toBe(201);
    const project = created.json().project as { id: string; name: string };
    expect(project.name).toBe("Payments");

    const inaccessible = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}`,
      headers: { authorization: `Bearer ${secondUser.token}` },
    });
    expect(inaccessible.statusCode).toBe(404);

    const projects = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${secondUser.token}` },
    });
    expect(projects.statusCode).toBe(200);
    expect(projects.json().projects).toEqual([]);
  });

  it("manages an endpoint without exposing its signing secret", async () => {
    const { app } = await createApplication();
    const user = await register(app, "owner@example.com");
    const otherUser = await register(app, "other@example.com");
    const projectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${user.token}` },
      payload: { name: "Delivery" },
    });
    const projectId = projectResponse.json().project.id as string;

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/endpoints`,
      headers: { authorization: `Bearer ${user.token}` },
      payload: { name: "Primary receiver", url: "https://example.com/hook" },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json();
    expect(createdBody.signingSecret).toMatch(/^whsec_/);
    expect(createdBody.endpoint).not.toHaveProperty("signingSecret");

    const endpointId = createdBody.endpoint.id as string;
    const otherTenantList = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/endpoints`,
      headers: { authorization: `Bearer ${otherUser.token}` },
    });
    expect(otherTenantList.statusCode).toBe(404);

    const otherTenantDetail = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/endpoints/${endpointId}`,
      headers: { authorization: `Bearer ${otherUser.token}` },
    });
    expect(otherTenantDetail.statusCode).toBe(404);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/endpoints/${endpointId}`,
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().endpoint).not.toHaveProperty("signingSecret");

    const paused = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/endpoints/${endpointId}/pause`,
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().endpoint.status).toBe("paused");

    const resumed = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/endpoints/${endpointId}/resume`,
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(resumed.json().endpoint.status).toBe("active");

    const rotated = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/endpoints/${endpointId}/rotate-secret`,
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().signingSecret).toMatch(/^whsec_/);
    expect(rotated.json().signingSecret).not.toBe(createdBody.signingSecret);

    const disabled = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/endpoints/${endpointId}`,
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(disabled.statusCode).toBe(204);
  });

  it("revokes sessions on logout", async () => {
    const { app } = await createApplication();
    await register(app, "logout@example.com");
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "logout@example.com",
        password: "correct horse battery staple",
      },
    });
    expect(login.statusCode).toBe(200);
    const loginToken = login.json().token as string;

    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { authorization: `Bearer ${loginToken}` },
    });
    expect(logout.statusCode).toBe(204);

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${loginToken}` },
    });
    expect(me.statusCode).toBe(401);
  });

  it("persists an event and fans it out only to active endpoints", async () => {
    const { app, store } = await createApplication();
    const user = await register(app, "events@example.com");
    const projectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${user.token}` },
      payload: { name: "Events" },
    });
    const projectId = projectResponse.json().project.id as string;
    const headers = { authorization: `Bearer ${user.token}` };

    const activeEndpoint = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/endpoints`,
      headers,
      payload: { name: "Active", url: "https://example.com/active" },
    });
    const pausedEndpoint = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/endpoints`,
      headers,
      payload: { name: "Paused", url: "https://example.com/paused" },
    });
    const pausedEndpointId = pausedEndpoint.json().endpoint.id as string;
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/endpoints/${pausedEndpointId}/pause`,
      headers,
    });

    const event = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/events`,
      headers: { ...headers, "idempotency-key": "payment-1" },
      payload: {
        eventType: "payment.created",
        payload: { amount: 1250, paymentId: "pay_123" },
      },
    });
    expect(event.statusCode).toBe(202);
    expect(event.json()).toMatchObject({
      deliveriesScheduled: 1,
      deduplicated: false,
    });
    expect(store.events.size).toBe(1);
    expect(store.deliveries).toHaveLength(1);
    expect(store.deliveries[0]?.endpointId).toBe(
      activeEndpoint.json().endpoint.id,
    );

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/events`,
      headers: { ...headers, "idempotency-key": "payment-1" },
      payload: {
        eventType: "payment.created",
        payload: { paymentId: "pay_123", amount: 1250 },
      },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().deduplicated).toBe(true);
    expect(duplicate.json().event.id).toBe(event.json().event.id);
    expect(store.events.size).toBe(1);
    expect(store.deliveries).toHaveLength(1);

    const reused = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/events`,
      headers: { ...headers, "idempotency-key": "payment-1" },
      payload: {
        eventType: "payment.updated",
        payload: { paymentId: "pay_123", amount: 1500 },
      },
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("does not allow another tenant to enqueue events for the project", async () => {
    const { app, store } = await createApplication();
    const owner = await register(app, "event-owner@example.com");
    const otherUser = await register(app, "event-other@example.com");
    const projectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: "Private events" },
    });
    const projectId = projectResponse.json().project.id as string;

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/events`,
      headers: { authorization: `Bearer ${otherUser.token}` },
      payload: { eventType: "private.test", payload: {} },
    });

    expect(response.statusCode).toBe(404);
    expect(store.events.size).toBe(0);
  });

  it("rejects event payloads over the configured limit", async () => {
    const { app } = await createApplication(new MemoryStore(), {
      ...config,
      MAX_EVENT_PAYLOAD_BYTES: 1_024,
    });
    const user = await register(app, "large-event@example.com");
    const projectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${user.token}` },
      payload: { name: "Large events" },
    });
    const projectId = projectResponse.json().project.id as string;

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/events`,
      headers: { authorization: `Bearer ${user.token}` },
      payload: {
        eventType: "large.test",
        payload: { value: "x".repeat(2_000) },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

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

async function createApplication(store = new MemoryStore()) {
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
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password: "correct horse battery staple" },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { token: string };
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

describe("dashboard routes (MemoryStore test double, no PostgreSQL)", () => {
  it("aggregates project-wide endpoint and delivery states without fan-out", async () => {
    const { app, store } = await createApplication();
    const owner = await register(app, "dashboard-owner@example.com");
    const foreign = await register(app, "dashboard-foreign@example.com");
    const projectId = await createProject(app, owner.token, "Dashboard");
    const headers = { authorization: `Bearer ${owner.token}` };

    const zeroDeliveryEvent = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/events`,
      headers,
      payload: { eventType: "before.endpoints", payload: {} },
    });
    expect(zeroDeliveryEvent.statusCode).toBe(202);
    expect(zeroDeliveryEvent.json().deliveriesScheduled).toBe(0);

    const endpointIds: string[] = [];
    for (const name of ["Active one", "Paused", "Disabled", "Active two"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/endpoints`,
        headers,
        payload: {
          name,
          url: `https://example.com/${name.replaceAll(" ", "-")}`,
        },
      });
      expect(response.statusCode).toBe(201);
      endpointIds.push(response.json().endpoint.id as string);
    }

    const event = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/events`,
      headers,
      payload: { eventType: "dashboard.created", payload: { secret: true } },
    });
    expect(event.statusCode).toBe(202);
    expect(store.deliveries).toHaveLength(4);
    store.deliveries[0]!.status = "pending";
    store.deliveries[1]!.status = "in_flight";
    store.deliveries[2]!.status = "delivered";
    store.deliveries[3]!.status = "failed";

    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/deliveries/${store.deliveries[3]!.id}/replay`,
      headers,
    });
    expect(replay.statusCode).toBe(202);

    // Another owned project has data but must not affect these counts.
    const otherProjectId = await createProject(app, owner.token, "Other");
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${otherProjectId}/endpoints`,
      headers,
      payload: { name: "Other receiver", url: "https://example.com/other" },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${otherProjectId}/events`,
      headers,
      payload: { eventType: "other.created", payload: {} },
    });

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/projects/${projectId}/endpoints/${endpointIds[1]}/pause`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/v1/projects/${projectId}/endpoints/${endpointIds[2]}`,
          headers,
        })
      ).statusCode,
    ).toBe(204);

    const overview = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/overview`,
      headers,
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toEqual({
      overview: {
        events: 2,
        endpoints: { active: 2, paused: 1, disabled: 1 },
        deliveries: {
          pending: 2,
          in_flight: 1,
          delivered: 1,
          failed: 1,
        },
      },
    });

    const foreignOverview = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/overview`,
      headers: { authorization: `Bearer ${foreign.token}` },
    });
    expect(foreignOverview.statusCode).toBe(404);
    const unknownOverview = await app.inject({
      method: "GET",
      url: "/api/v1/projects/00000000-0000-4000-8000-000000000000/overview",
      headers,
    });
    expect(unknownOverview.statusCode).toBe(404);
  });

  it("lists payload-free events with event filtering, keyset pagination, and strict queries", async () => {
    const { app, store } = await createApplication();
    const owner = await register(app, "event-list-owner@example.com");
    const foreign = await register(app, "event-list-foreign@example.com");
    const projectId = await createProject(app, owner.token, "Event list");
    const headers = { authorization: `Bearer ${owner.token}` };

    const eventIds: string[] = [];
    for (const eventType of [
      "dashboard.created",
      "dashboard.updated",
      "dashboard.created",
      "dashboard.updated",
      "dashboard.created",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/events`,
        headers,
        payload: { eventType, payload: { shouldNot: "be listed" } },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json().deliveriesScheduled).toBe(0);
      eventIds.push(response.json().event.id as string);
    }
    const timestamps = [
      "2026-01-01T00:00:00.123001Z",
      "2026-01-01T00:00:00.123002Z",
      "2026-01-01T00:00:00.123002Z",
      "2026-01-01T00:00:00.124000Z",
      "2026-01-01T00:00:00.125000Z",
    ];
    for (const [index, id] of eventIds.entries()) {
      store.events.get(id)!.createdAt = timestamps[index]!;
    }
    const tiedIds = [eventIds[1]!, eventIds[2]!].sort().reverse();
    const expectedIds = [eventIds[4], eventIds[3], ...tiedIds, eventIds[0]];

    const firstPage = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/events?limit=3`,
      headers,
    });
    expect(firstPage.statusCode).toBe(200);
    expect(
      firstPage.json().events.map((event: { id: string }) => event.id),
    ).toEqual(expectedIds.slice(0, 3));
    for (const event of firstPage.json().events) {
      expect(Object.keys(event).sort()).toEqual([
        "createdAt",
        "eventType",
        "id",
        "projectId",
      ]);
    }
    expect(firstPage.json().pagination.limit).toBe(3);
    expect(firstPage.json().pagination.nextCursor).toEqual(expect.any(String));
    expect(
      JSON.parse(
        Buffer.from(
          firstPage.json().pagination.nextCursor,
          "base64url",
        ).toString("utf8"),
      ),
    ).toEqual({
      createdAt: "2026-01-01T00:00:00.123002Z",
      id: tiedIds[0],
    });

    const secondPage = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/events?limit=3&cursor=${encodeURIComponent(firstPage.json().pagination.nextCursor)}`,
      headers,
    });
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json().events).toHaveLength(2);
    expect(
      secondPage.json().events.map((event: { id: string }) => event.id),
    ).toEqual(expectedIds.slice(3));
    expect(secondPage.json().pagination.nextCursor).toBeNull();

    const filtered = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/events?eventType=dashboard.created`,
      headers,
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().events).toHaveLength(3);
    expect(filtered.json().pagination).toEqual({ limit: 25, nextCursor: null });
    expect(
      filtered
        .json()
        .events.every(
          (event: { eventType: string }) =>
            event.eventType === "dashboard.created",
        ),
    ).toBe(true);

    const invalidCursor = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/events?cursor=not-a-cursor`,
      headers,
    });
    expect(invalidCursor.statusCode).toBe(400);
    expect(invalidCursor.json().error.code).toBe("INVALID_CURSOR");

    const unsupportedTimeFilter = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/events?from=2026-01-01T00:00:00Z`,
      headers,
    });
    expect(unsupportedTimeFilter.statusCode).toBe(400);
    expect(unsupportedTimeFilter.json().error.code).toBe("VALIDATION_ERROR");

    const foreignList = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/events`,
      headers: { authorization: `Bearer ${foreign.token}` },
    });
    expect(foreignList.statusCode).toBe(404);
  });

  it("requires authentication, validates project IDs, and returns empty owned projects", async () => {
    const { app } = await createApplication();
    const owner = await register(app, "dashboard-empty@example.com");
    const projectId = await createProject(app, owner.token, "Empty");
    const headers = { authorization: `Bearer ${owner.token}` };

    for (const route of ["overview", "events"]) {
      const anonymous = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/${route}`,
      });
      expect(anonymous.statusCode).toBe(401);
      const invalidProject = await app.inject({
        method: "GET",
        url: `/api/v1/projects/not-a-uuid/${route}`,
        headers,
      });
      expect(invalidProject.statusCode).toBe(400);
      const unknown = await app.inject({
        method: "GET",
        url: `/api/v1/projects/00000000-0000-4000-8000-000000000000/${route}`,
        headers,
      });
      expect(unknown.statusCode).toBe(404);
    }
    const overview = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/overview`,
      headers,
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toEqual({
      overview: {
        events: 0,
        endpoints: { active: 0, paused: 0, disabled: 0 },
        deliveries: { pending: 0, in_flight: 0, delivered: 0, failed: 0 },
      },
    });
    const events = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/events`,
      headers,
    });
    expect(events.statusCode).toBe(200);
    expect(events.json()).toEqual({
      events: [],
      pagination: { limit: 25, nextCursor: null },
    });
  });

  it("rejects malformed, repeated, and unsupported queries and cursor fields", async () => {
    const { app } = await createApplication();
    const owner = await register(app, "dashboard-validation@example.com");
    const projectId = await createProject(app, owner.token, "Validation");
    const headers = { authorization: `Bearer ${owner.token}` };
    for (const query of [
      "limit=",
      "limit=0",
      "limit=-1",
      "limit=101",
      "limit=1.5",
      "limit=1e1",
      "limit=0x10",
      "limit=%2025",
      "limit=1&limit=2",
      "cursor=",
      "cursor=a&cursor=b",
      `cursor=${"a".repeat(513)}`,
      "eventType=",
      "eventType=%20",
      "eventType=a&eventType=b",
      `eventType=${"x".repeat(101)}`,
      "from=invalid",
      "to=2026-01-01T00:00:00Z",
      "unknown=true",
      "status=pending",
    ]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/events?${query}`,
        headers,
      });
      expect(response.statusCode, query).toBe(400);
      expect(response.json().error.code, query).toBe("VALIDATION_ERROR");
    }

    const cursor = {
      id: "00000000-0000-4000-8000-000000000001",
      createdAt: "2026-01-01T00:00:00.123456Z",
    };
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    for (const value of [
      "%%%",
      "a",
      encode(null),
      encode([]),
      encode({}),
      encode({ ...cursor, id: "not-a-uuid" }),
      encode({ ...cursor, createdAt: "2026-02-30T00:00:00.123456Z" }),
      encode({ ...cursor, createdAt: "0000-01-01T00:00:00.123456Z" }),
      encode({ ...cursor, createdAt: "2026-01-01T00:00:00.1234567Z" }),
      encode({ ...cursor, createdAt: "2026-01-01T00:00:00.123456+02:00" }),
      encode({ ...cursor, extra: true }),
      `${encode(cursor)}=`,
    ]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/events?cursor=${encodeURIComponent(value)}`,
        headers,
      });
      expect(response.statusCode, value).toBe(400);
      expect(response.json().error.code, value).toBe("INVALID_CURSOR");
    }
    const overview = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/overview?limit=1`,
      headers,
    });
    expect(overview.statusCode).toBe(400);
  });

  it("counts beyond listing limits and paginates the default 25 events", async () => {
    const { app, store } = await createApplication();
    const owner = await register(app, "dashboard-many@example.com");
    const projectId = await createProject(app, owner.token, "Many events");
    const headers = { authorization: `Bearer ${owner.token}` };
    // Seed the double directly: these assertions exercise routes, not SQL.
    for (let index = 0; index < 101; index += 1) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      store.events.set(id, {
        id,
        projectId,
        eventType: "many.created",
        payload: { index },
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    }
    const overview = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/overview`,
      headers,
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().overview.events).toBe(101);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/events${cursor ? `?cursor=${cursor}` : ""}`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().pagination.limit).toBe(25);
      seen.push(
        ...response.json().events.map((event: { id: string }) => event.id),
      );
      cursor = response.json().pagination.nextCursor as string | null;
      expect(seen.length).toBeLessThanOrEqual(101);
    } while (cursor);
    expect(seen).toEqual([...store.events.keys()].sort().reverse());
  });
});

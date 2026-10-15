import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseConfig } from "../../apps/api/src/config.js";
import { PgStore } from "../../apps/api/src/store.js";

const config = parseConfig();
const pool = new Pool({ connectionString: config.DATABASE_URL });
const store = new PgStore(pool);
const userId = randomUUID();
const foreignUserId = randomUUID();
const projectId = randomUUID();
const activeEndpointId = randomUUID();
const pausedEndpointId = randomUUID();
const disabledEndpointId = randomUUID();
const eventIds = [
  randomUUID(),
  randomUUID(),
  randomUUID(),
  randomUUID(),
  randomUUID(),
];
const deliveryIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

const eventFixtures = [
  [eventIds[0]!, "dashboard.pending", "2026-01-01T00:00:00.123401Z"],
  [eventIds[1]!, "dashboard.in_flight", "2026-01-01T00:00:00.123402Z"],
  [eventIds[2]!, "dashboard.delivered", "2026-01-01T00:00:00.123403Z"],
  [eventIds[3]!, "dashboard.failed", "2026-01-01T00:00:00.123404Z"],
  [eventIds[4]!, "dashboard.no_delivery", "2026-01-01T00:00:00.123405Z"],
] as const;

beforeAll(async () => {
  await pool.query(
    `INSERT INTO users (id, email, email_normalized, password_hash)
     VALUES ($1, $2, $2, 'integration-test'),
            ($3, $4, $4, 'integration-test')`,
    [
      userId,
      `dashboard-${userId}@example.com`,
      foreignUserId,
      `dashboard-${foreignUserId}@example.com`,
    ],
  );
  await pool.query(
    `INSERT INTO projects (id, owner_id, name, name_normalized, public_identifier)
     VALUES ($1, $2, 'Dashboard project', $3, $4)`,
    [projectId, userId, `dashboard-${projectId}`, `hf_dashboard_${projectId}`],
  );
  await pool.query(
    `INSERT INTO endpoints (id, project_id, name, name_normalized, url, status)
     VALUES ($1, $4, 'Active', $5, 'https://example.com/active', 'active'),
            ($2, $4, 'Paused', $6, 'https://example.com/paused', 'paused'),
            ($3, $4, 'Disabled', $7, 'https://example.com/disabled', 'disabled')`,
    [
      activeEndpointId,
      pausedEndpointId,
      disabledEndpointId,
      projectId,
      `dashboard-active-${projectId}`,
      `dashboard-paused-${projectId}`,
      `dashboard-disabled-${projectId}`,
    ],
  );

  for (const [id, eventType, createdAt] of eventFixtures) {
    await pool.query(
      `INSERT INTO events (id, project_id, event_type, payload, created_at)
       VALUES ($1, $2, $3, '{"source":"dashboard-integration"}', $4)`,
      [id, projectId, eventType, createdAt],
    );
  }

  const deliveryStatuses = ["pending", "in_flight", "delivered", "failed"];
  for (const [index, status] of deliveryStatuses.entries()) {
    await pool.query(
      `INSERT INTO deliveries
         (id, event_id, endpoint_id, endpoint_url, endpoint_secret_version,
         status, next_attempt_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'https://example.com/active', 1, $4,
               now() + interval '1 hour', $5, $5)`,
      [
        deliveryIds[index],
        eventIds[index],
        activeEndpointId,
        status,
        eventFixtures[index]![2],
      ],
    );
  }
});

afterAll(async () => {
  await pool.query("DELETE FROM deliveries WHERE id = ANY($1::uuid[])", [
    deliveryIds,
  ]);
  await pool.query("DELETE FROM events WHERE id = ANY($1::uuid[])", [eventIds]);
  await pool.query("DELETE FROM endpoints WHERE project_id = $1", [projectId]);
  await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
  await pool.query("DELETE FROM users WHERE id IN ($1, $2)", [
    userId,
    foreignUserId,
  ]);
  await pool.end();
});

describe("PostgreSQL dashboard queries", () => {
  it("counts project-wide states independently and includes zero-delivery events", async () => {
    const overview = await store.getProjectOverview(userId, projectId);

    expect(overview).toEqual({
      events: 5,
      endpoints: { active: 1, paused: 1, disabled: 1 },
      deliveries: {
        pending: 1,
        in_flight: 1,
        delivered: 1,
        failed: 1,
      },
    });
    expect(await store.getProjectOverview(foreignUserId, projectId)).toBeNull();
  });

  it("uses a microsecond-preserving keyset cursor and excludes payloads", async () => {
    const first = await store.listEvents(userId, projectId, { limit: 2 });
    expect(first).not.toBeNull();
    expect(first!.events.map((event) => event.id)).toEqual([
      eventIds[4],
      eventIds[3],
    ]);
    expect(first!.events[0]).toEqual({
      id: eventIds[4],
      projectId,
      eventType: "dashboard.no_delivery",
      createdAt: "2026-01-01T00:00:00.123Z",
    });
    expect(first!.events[0]).not.toHaveProperty("payload");
    expect(first!.nextCursor).toEqual({
      createdAt: "2026-01-01T00:00:00.123404Z",
      id: eventIds[3],
    });

    const second = await store.listEvents(userId, projectId, {
      limit: 2,
      cursor: first!.nextCursor!,
    });
    expect(second!.events.map((event) => event.id)).toEqual([
      eventIds[2],
      eventIds[1],
    ]);

    const third = await store.listEvents(userId, projectId, {
      limit: 2,
      cursor: second!.nextCursor!,
    });
    expect(third!.events.map((event) => event.id)).toEqual([eventIds[0]]);
    expect(third!.nextCursor).toBeNull();

    const filtered = await store.listEvents(userId, projectId, {
      limit: 10,
      eventType: "dashboard.no_delivery",
    });
    expect(filtered!.events).toHaveLength(1);
    expect(
      await store.listEvents(foreignUserId, projectId, { limit: 10 }),
    ).toBeNull();
  });
});

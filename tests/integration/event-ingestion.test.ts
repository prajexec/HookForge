import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseConfig } from "../../apps/api/src/config.js";
import { PgStore } from "../../apps/api/src/store.js";

const config = parseConfig();
const pool = new Pool({ connectionString: config.DATABASE_URL });
const store = new PgStore(pool);
const userId = randomUUID();
const projectId = randomUUID();
const activeEndpointId = randomUUID();
const pausedEndpointId = randomUUID();

beforeAll(async () => {
  await pool.query(
    `INSERT INTO users (id, email, email_normalized, password_hash)
     VALUES ($1, $2, $2, $3)`,
    [userId, `integration-${userId}@example.com`, "integration-test"],
  );
  await pool.query(
    `INSERT INTO projects (id, owner_id, name, name_normalized, public_identifier)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      projectId,
      userId,
      "Integration project",
      `integration-${projectId}`,
      `hf_int_${projectId}`,
    ],
  );
  await pool.query(
    `INSERT INTO endpoints (id, project_id, name, name_normalized, url, status)
     VALUES
       ($1, $3, 'Active', 'active', 'https://example.com/active', 'active'),
       ($2, $3, 'Paused', 'paused', 'https://example.com/paused', 'paused')`,
    [activeEndpointId, pausedEndpointId, projectId],
  );
});

afterAll(async () => {
  await pool.query(
    "DELETE FROM deliveries WHERE event_id IN (SELECT id FROM events WHERE project_id = $1)",
    [projectId],
  );
  await pool.query("DELETE FROM events WHERE project_id = $1", [projectId]);
  await pool.query("DELETE FROM endpoints WHERE project_id = $1", [projectId]);
  await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  await pool.end();
});

describe("PostgreSQL event ingestion", () => {
  it("commits the event and active-endpoint fan-out atomically", async () => {
    const result = await store.ingestEvent({
      ownerId: userId,
      projectId,
      eventType: "integration.created",
      payload: { source: "vitest", sequence: 1 },
      idempotencyKey: "integration-1",
      requestHash: "a".repeat(64),
    });

    expect(result.deduplicated).toBe(false);
    expect(result.deliveryCount).toBe(1);

    const rows = await pool.query<{ status: string; endpoint_id: string }>(
      "SELECT status, endpoint_id FROM deliveries WHERE event_id = $1",
      [result.event.id],
    );
    expect(rows.rows).toEqual([
      { status: "pending", endpoint_id: activeEndpointId },
    ]);
  });

  it("returns the original event for a matching key and rejects a mismatch", async () => {
    const duplicate = await store.ingestEvent({
      ownerId: userId,
      projectId,
      eventType: "integration.created",
      payload: { source: "vitest", sequence: 1 },
      idempotencyKey: "integration-1",
      requestHash: "a".repeat(64),
    });
    expect(duplicate.deduplicated).toBe(true);
    expect(duplicate.deliveryCount).toBe(1);

    await expect(
      store.ingestEvent({
        ownerId: userId,
        projectId,
        eventType: "integration.changed",
        payload: { source: "vitest", sequence: 2 },
        idempotencyKey: "integration-1",
        requestHash: "b".repeat(64),
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "IDEMPOTENCY_KEY_REUSED",
    });
  });

  it("rolls back when the database rejects the event after insert begins", async () => {
    const before = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM events WHERE project_id = $1",
      [projectId],
    );

    await expect(
      store.ingestEvent({
        ownerId: userId,
        projectId,
        eventType: "x".repeat(101),
        payload: {},
        idempotencyKey: "integration-rollback",
        requestHash: "c".repeat(64),
      }),
    ).rejects.toThrow();

    const after = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM events WHERE project_id = $1",
      [projectId],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});

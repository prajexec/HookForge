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
const endpointId = randomUUID();
const failedEventId = randomUUID();
const failedDeliveryId = randomUUID();
const staleEventId = randomUUID();
const staleDeliveryId = randomUUID();

beforeAll(async () => {
  await pool.query(
    `INSERT INTO users (id, email, email_normalized, password_hash)
     VALUES ($1, $2, $2, 'integration-test')`,
    [userId, `inspection-${userId}@example.com`],
  );
  await pool.query(
    `INSERT INTO projects (id, owner_id, name, name_normalized, public_identifier)
     VALUES ($1, $2, 'Inspection project', $3, $4)`,
    [
      projectId,
      userId,
      `inspection-${projectId}`,
      `hf_inspection_${projectId}`,
    ],
  );
  await pool.query(
    `INSERT INTO endpoints (id, project_id, name, name_normalized, url, status)
     VALUES ($1, $2, 'Inspection endpoint', $3, 'https://example.com/inspection', 'active')`,
    [endpointId, projectId, `inspection-${endpointId}`],
  );
  await pool.query(
    `INSERT INTO endpoint_secrets (endpoint_id, version, ciphertext, iv, auth_tag)
     VALUES ($1, 1, 'ciphertext', 'iv', 'tag')`,
    [endpointId],
  );
  await pool.query(
    `INSERT INTO events (id, project_id, event_type, payload)
     VALUES ($1, $3, 'inspection.failed', '{"source":"integration"}'),
            ($2, $3, 'inspection.stale', '{"source":"integration"}')`,
    [failedEventId, staleEventId, projectId],
  );
  await pool.query(
    `INSERT INTO deliveries
       (id, event_id, endpoint_id, endpoint_url, endpoint_secret_version, status,
        attempt_count, last_http_status_code, last_error)
     VALUES
       ($1, $3, $4, 'https://example.com/inspection', 1, 'failed', 2, 503, 'unavailable'),
       ($2, $5, $4, 'https://example.com/inspection', 1, 'in_flight', 1, NULL, NULL)`,
    [
      failedDeliveryId,
      staleDeliveryId,
      failedEventId,
      endpointId,
      staleEventId,
    ],
  );
  await pool.query(
    `UPDATE deliveries
     SET lease_expires_at = now() - interval '1 second'
     WHERE id = $1`,
    [staleDeliveryId],
  );
  await pool.query(
    `INSERT INTO delivery_attempts
       (delivery_id, attempt_number, request_at, response_at,
        http_status_code, response_duration_ms, response_excerpt,
        error_classification, outcome)
     VALUES ($1, 1, now() - interval '2 seconds', now() - interval '1 second',
             503, 100, 'unavailable', 'http_server_error', 'retry')`,
    [failedDeliveryId],
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM deliveries WHERE id IN ($1, $2)", [
    failedDeliveryId,
    staleDeliveryId,
  ]);
  await pool.query("DELETE FROM events WHERE id IN ($1, $2)", [
    failedEventId,
    staleEventId,
  ]);
  await pool.query("DELETE FROM endpoint_secrets WHERE endpoint_id = $1", [
    endpointId,
  ]);
  await pool.query("DELETE FROM endpoints WHERE id = $1", [endpointId]);
  await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  await pool.end();
});

describe("PostgreSQL delivery inspection", () => {
  it("lists filtered deliveries with attempt history and creates a replay", async () => {
    const listed = await store.listDeliveries(userId, projectId, {
      limit: 10,
      status: "failed",
    });
    expect(listed.deliveries).toHaveLength(1);
    expect(listed.deliveries[0]?.id).toBe(failedDeliveryId);

    const detail = await store.getDelivery(userId, projectId, failedDeliveryId);
    expect(detail?.eventPayload).toEqual({ source: "integration" });
    expect(detail?.attempts).toHaveLength(1);

    const replay = await store.replayDelivery(
      userId,
      projectId,
      failedDeliveryId,
    );
    expect(replay).toMatchObject({
      replayOfDeliveryId: failedDeliveryId,
      replayNumber: 1,
      status: "pending",
    });
  });

  it("reconciles expired in-flight deliveries only within the project", async () => {
    const count = await store.reconcileExpiredDeliveries(userId, projectId);
    expect(count).toBe(1);
    const row = await pool.query<{
      status: string;
      lease_token: string | null;
    }>("SELECT status, lease_token FROM deliveries WHERE id = $1", [
      staleDeliveryId,
    ]);
    expect(row.rows[0]).toEqual({ status: "pending", lease_token: null });
  });
});

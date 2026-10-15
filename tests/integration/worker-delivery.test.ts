import { createCipheriv, randomBytes, randomUUID } from "node:crypto";

import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { parseWorkerConfig } from "../../apps/worker/src/config.js";
import {
  PgDeliveryStore,
  type DeliveryJob,
} from "../../apps/worker/src/delivery-store.js";

const config = parseWorkerConfig();
const pool = new Pool({ connectionString: config.DATABASE_URL });
const store = new PgDeliveryStore(config.DATABASE_URL, pool);
const userId = randomUUID();
const projectId = randomUUID();
const endpointId = randomUUID();
const secondEndpointId = randomUUID();
const createdDeliveryIds: string[] = [];
const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function encryptedSecret() {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(encryptionKey, "base64"),
    iv,
  );
  const ciphertext = Buffer.concat([
    cipher.update("whsec_integration", "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
  };
}

beforeAll(async () => {
  await pool.query(
    `INSERT INTO users (id, email, email_normalized, password_hash)
     VALUES ($1, $2, $2, $3)`,
    [userId, `worker-${userId}@example.com`, "integration-test"],
  );
  await pool.query(
    `INSERT INTO projects (id, owner_id, name, name_normalized, public_identifier)
     VALUES ($1, $2, 'Worker integration', $3, $4)`,
    [projectId, userId, `worker-${projectId}`, `hf_worker_${projectId}`],
  );
  await pool.query(
    `INSERT INTO endpoints (id, project_id, name, name_normalized, url, status)
     VALUES ($1, $2, 'Worker endpoint', $3, 'https://example.com/worker', 'active')`,
    [endpointId, projectId, `worker-${endpointId}`],
  );
  await pool.query(
    `INSERT INTO endpoints (id, project_id, name, name_normalized, url, status)
     VALUES ($1, $2, 'Second worker endpoint', $3, 'https://example.com/worker-2', 'active')`,
    [secondEndpointId, projectId, `worker-${secondEndpointId}`],
  );
  const secret = encryptedSecret();
  await pool.query(
    `INSERT INTO endpoint_secrets (endpoint_id, version, ciphertext, iv, auth_tag)
     VALUES ($1, 1, $2, $3, $4)`,
    [endpointId, secret.ciphertext, secret.iv, secret.authTag],
  );
  const secondSecret = encryptedSecret();
  await pool.query(
    `INSERT INTO endpoint_secrets (endpoint_id, version, ciphertext, iv, auth_tag)
     VALUES ($1, 1, $2, $3, $4)`,
    [
      secondEndpointId,
      secondSecret.ciphertext,
      secondSecret.iv,
      secondSecret.authTag,
    ],
  );
});

async function createDelivery(targetEndpointId = endpointId): Promise<string> {
  const endpointUrl =
    targetEndpointId === endpointId
      ? "https://example.com/worker"
      : "https://example.com/worker-2";
  const event = await pool.query<{ id: string }>(
    `INSERT INTO events (project_id, event_type, payload)
     VALUES ($1, 'worker.integration', '{"ok":true}')
     RETURNING id`,
    [projectId],
  );
  const delivery = await pool.query<{ id: string }>(
    `INSERT INTO deliveries
       (event_id, endpoint_id, endpoint_url, endpoint_secret_version)
     VALUES (
       $1,
       $2,
       $3,
       1
     )
     RETURNING id`,
    [event.rows[0]!.id, targetEndpointId, endpointUrl],
  );
  createdDeliveryIds.push(delivery.rows[0]!.id);
  return delivery.rows[0]!.id;
}

beforeEach(async () => {
  await createDelivery();
});

afterEach(async () => {
  await pool.query("DELETE FROM deliveries WHERE id = ANY($1::uuid[])", [
    createdDeliveryIds,
  ]);
});

afterAll(async () => {
  await pool.query("DELETE FROM deliveries WHERE id = ANY($1::uuid[])", [
    createdDeliveryIds,
  ]);
  await pool.query("DELETE FROM endpoint_secrets WHERE endpoint_id = $1", [
    endpointId,
  ]);
  await pool.query("DELETE FROM endpoint_secrets WHERE endpoint_id = $1", [
    secondEndpointId,
  ]);
  await pool.query("DELETE FROM endpoints WHERE id = $1", [endpointId]);
  await pool.query("DELETE FROM endpoints WHERE id = $1", [secondEndpointId]);
  await pool.query("DELETE FROM events WHERE project_id = $1", [projectId]);
  await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  await pool.end();
});

describe("PostgreSQL worker leasing", () => {
  it("persists a fresh heartbeat and can mark the worker inactive", async () => {
    await store.heartbeat({
      workerId: "integration-worker",
      concurrency: 2,
      activeJobs: 1,
    });
    const active = await pool.query<{
      active: boolean;
      concurrency: number;
      active_jobs: number;
    }>(
      "SELECT active, concurrency, active_jobs FROM worker_heartbeats WHERE worker_id = $1",
      ["integration-worker"],
    );
    expect(active.rows[0]).toEqual({
      active: true,
      concurrency: 2,
      active_jobs: 1,
    });

    await store.stopHeartbeat("integration-worker");
    const stopped = await pool.query<{ active: boolean }>(
      "SELECT active FROM worker_heartbeats WHERE worker_id = $1",
      ["integration-worker"],
    );
    expect(stopped.rows[0]?.active).toBe(false);
    await pool.query("DELETE FROM worker_heartbeats WHERE worker_id = $1", [
      "integration-worker",
    ]);
  });

  it("claims a due delivery and records the complete attempt transaction", async () => {
    const job = await store.claimDueDelivery({
      leaseSeconds: 60,
      maxInFlightPerEndpoint: 5,
      maxInFlightPerProject: 5,
    });
    expect(job).not.toBeNull();
    expect(job).toMatchObject<Partial<DeliveryJob>>({
      endpointId,
      endpointSecretVersion: 1,
      attemptNumber: 1,
    });

    const requestAt = new Date();
    await store.recordAttempt({
      job: job!,
      requestAt,
      responseAt: new Date(requestAt.getTime() + 25),
      responseDurationMs: 25,
      httpStatusCode: 200,
      responseExcerpt: "ok",
      errorClassification: "http_success",
      lastError: null,
      outcome: "success",
      nextAttemptAt: null,
    });

    const delivery = await pool.query<{
      status: string;
      attempt_count: number;
    }>("SELECT status, attempt_count FROM deliveries WHERE id = $1", [job!.id]);
    const attempts = await pool.query<{
      outcome: string;
      attempt_number: number;
    }>(
      "SELECT outcome, attempt_number FROM delivery_attempts WHERE delivery_id = $1",
      [job!.id],
    );
    expect(delivery.rows[0]).toEqual({ status: "delivered", attempt_count: 1 });
    expect(attempts.rows[0]).toEqual({ outcome: "success", attempt_number: 1 });
  });

  it("caps concurrent claims for one endpoint across worker connections", async () => {
    await createDelivery();
    await createDelivery();
    await createDelivery();

    const claims = await Promise.all(
      Array.from({ length: 4 }, () =>
        store.claimDueDelivery({
          leaseSeconds: 60,
          maxInFlightPerEndpoint: 2,
          maxInFlightPerProject: 10,
        }),
      ),
    );
    expect(claims.filter((job) => job !== null)).toHaveLength(2);

    const inFlight = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM deliveries WHERE endpoint_id = $1 AND status = 'in_flight'",
      [endpointId],
    );
    expect(Number(inFlight.rows[0]?.count)).toBe(2);
  });

  it("caps concurrent claims for a project without blocking another endpoint", async () => {
    await createDelivery();
    await createDelivery(secondEndpointId);
    await createDelivery(secondEndpointId);

    const claims = await Promise.all(
      Array.from({ length: 4 }, () =>
        store.claimDueDelivery({
          leaseSeconds: 60,
          maxInFlightPerEndpoint: 10,
          maxInFlightPerProject: 2,
        }),
      ),
    );
    expect(claims.filter((job) => job !== null)).toHaveLength(2);

    const inFlight = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM deliveries d
         JOIN events e ON e.id = d.event_id
        WHERE e.project_id = $1 AND d.status = 'in_flight'`,
      [projectId],
    );
    expect(Number(inFlight.rows[0]?.count)).toBe(2);
  });

  it("skips a saturated endpoint and claims an eligible endpoint", async () => {
    const first = await store.claimDueDelivery({
      leaseSeconds: 60,
      maxInFlightPerEndpoint: 1,
      maxInFlightPerProject: 10,
    });
    expect(first?.endpointId).toBe(endpointId);

    const blocked = await createDelivery();
    const eligible = await createDelivery(secondEndpointId);
    await pool.query(
      `UPDATE deliveries
          SET next_attempt_at = CASE WHEN id = $1 THEN now() - interval '1 second' ELSE now() END
        WHERE id IN ($1, $2)`,
      [blocked, eligible],
    );

    const next = await store.claimDueDelivery({
      leaseSeconds: 60,
      maxInFlightPerEndpoint: 1,
      maxInFlightPerProject: 10,
    });
    expect(next?.id).toBe(eligible);
  });

  it("releases endpoint capacity when an attempt is recorded", async () => {
    const first = await store.claimDueDelivery({
      leaseSeconds: 60,
      maxInFlightPerEndpoint: 1,
      maxInFlightPerProject: 10,
    });
    expect(first).not.toBeNull();
    const requestAt = new Date();
    await store.recordAttempt({
      job: first!,
      requestAt,
      responseAt: requestAt,
      responseDurationMs: 0,
      httpStatusCode: 200,
      responseExcerpt: "ok",
      errorClassification: "http_success",
      lastError: null,
      outcome: "success",
      nextAttemptAt: null,
    });

    const nextId = await createDelivery();
    const next = await store.claimDueDelivery({
      leaseSeconds: 60,
      maxInFlightPerEndpoint: 1,
      maxInFlightPerProject: 10,
    });
    expect(next?.id).toBe(nextId);
  });

  it("recovers an expired lease and increments the attempt number", async () => {
    const first = await store.claimDueDelivery({
      leaseSeconds: 60,
      maxInFlightPerEndpoint: 5,
      maxInFlightPerProject: 5,
    });
    expect(first).not.toBeNull();
    await pool.query(
      "UPDATE deliveries SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [first!.id],
    );

    const recovered = await store.claimDueDelivery({
      leaseSeconds: 60,
      maxInFlightPerEndpoint: 5,
      maxInFlightPerProject: 5,
    });
    expect(recovered).toMatchObject({
      id: first!.id,
      attemptNumber: 2,
    });
  });
});

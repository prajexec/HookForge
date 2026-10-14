import { randomUUID } from "node:crypto";

import { Pool, type PoolClient, type QueryResultRow } from "pg";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface DeliveryJob {
  id: string;
  eventId: string;
  eventType: string;
  payload: JsonValue;
  endpointId: string;
  endpointUrl: string;
  endpointSecretVersion: number;
  encryptedSecret: {
    ciphertext: string;
    iv: string;
    authTag: string;
  };
  attemptNumber: number;
  leaseToken: string;
}

export type AttemptOutcome = "success" | "retry" | "failed";

export interface DeliveryAttemptInput {
  job: DeliveryJob;
  requestAt: Date;
  responseAt: Date | null;
  responseDurationMs: number | null;
  httpStatusCode: number | null;
  responseExcerpt: string | null;
  errorClassification: string | null;
  lastError: string | null;
  outcome: AttemptOutcome;
  nextAttemptAt: Date | null;
}

export class LeaseLostError extends Error {
  public constructor() {
    super("Delivery lease was lost before the attempt could be recorded");
    this.name = "LeaseLostError";
  }
}

export interface DeliveryStore {
  claimDueDelivery(leaseSeconds: number): Promise<DeliveryJob | null>;
  recordAttempt(input: DeliveryAttemptInput): Promise<void>;
  heartbeat(input: {
    workerId: string;
    concurrency: number;
    activeJobs: number;
  }): Promise<void>;
  stopHeartbeat(workerId: string): Promise<void>;
  close(): Promise<void>;
}

type DatabaseRow = QueryResultRow & Record<string, unknown>;

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original database error.
  }
}

function mapJob(row: DatabaseRow): DeliveryJob {
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    eventType: String(row.event_type),
    payload: row.payload as JsonValue,
    endpointId: String(row.endpoint_id),
    endpointUrl: String(row.endpoint_url),
    endpointSecretVersion: Number(row.endpoint_secret_version),
    encryptedSecret: {
      ciphertext: String(row.ciphertext),
      iv: String(row.iv),
      authTag: String(row.auth_tag),
    },
    attemptNumber: Number(row.attempt_number),
    leaseToken: String(row.lease_token),
  };
}

export class PgDeliveryStore implements DeliveryStore {
  private readonly pool: Pool;

  public constructor(databaseUrl: string, pool?: Pool) {
    this.pool =
      pool ??
      new Pool({
        connectionString: databaseUrl,
        max: 10,
        connectionTimeoutMillis: 2_000,
        idleTimeoutMillis: 30_000,
      });
  }

  public async claimDueDelivery(
    leaseSeconds: number,
  ): Promise<DeliveryJob | null> {
    const client = await this.pool.connect();
    const leaseToken = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE deliveries
         SET status = 'pending', lease_expires_at = NULL, lease_token = NULL,
             updated_at = now()
         WHERE status = 'in_flight' AND lease_expires_at <= now()`,
      );

      const claimed = await client.query<DatabaseRow>(
        `WITH candidate AS (
           SELECT id
           FROM deliveries
           WHERE status = 'pending' AND next_attempt_at <= now()
           ORDER BY next_attempt_at, id
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE deliveries d
         SET status = 'in_flight',
             attempt_count = d.attempt_count + 1,
             lease_expires_at = now() + ($1::integer * interval '1 second'),
             lease_token = $2::uuid,
             updated_at = now()
         FROM candidate
         WHERE d.id = candidate.id
         RETURNING d.id`,
        [leaseSeconds, leaseToken],
      );
      if (claimed.rowCount === 0) {
        await client.query("COMMIT");
        return null;
      }

      const job = await client.query<DatabaseRow>(
        `SELECT
           d.id,
           d.event_id,
           d.endpoint_id,
           d.endpoint_url,
           d.endpoint_secret_version,
           d.attempt_count AS attempt_number,
           d.lease_token,
           e.event_type,
           e.payload,
           s.ciphertext,
           s.iv,
           s.auth_tag
         FROM deliveries d
         JOIN events e ON e.id = d.event_id
         JOIN endpoint_secrets s
           ON s.endpoint_id = d.endpoint_id
          AND s.version = d.endpoint_secret_version
         WHERE d.id = $1 AND d.lease_token = $2::uuid`,
        [claimed.rows[0]!.id, leaseToken],
      );
      if (!job.rows[0]) {
        throw new Error("Claimed delivery configuration could not be loaded");
      }
      await client.query("COMMIT");
      return mapJob(job.rows[0]);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async recordAttempt(input: DeliveryAttemptInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const status =
        input.outcome === "success"
          ? "delivered"
          : input.outcome === "retry"
            ? "pending"
            : "failed";
      const updated = await client.query<DatabaseRow>(
        `UPDATE deliveries
         SET status = $2,
             next_attempt_at = COALESCE($3, next_attempt_at),
             lease_expires_at = NULL,
             lease_token = NULL,
             last_http_status_code = $4,
             last_error = $5,
             updated_at = now(),
             completed_at = CASE WHEN $2 IN ('delivered', 'failed') THEN now() ELSE NULL END
         WHERE id = $1 AND status = 'in_flight' AND lease_token = $6::uuid
         RETURNING id`,
        [
          input.job.id,
          status,
          input.nextAttemptAt,
          input.httpStatusCode,
          input.lastError,
          input.job.leaseToken,
        ],
      );
      if (updated.rowCount === 0) {
        throw new LeaseLostError();
      }
      await client.query(
        `INSERT INTO delivery_attempts
           (delivery_id, attempt_number, request_at, response_at,
            http_status_code, response_duration_ms, response_excerpt,
            error_classification, outcome)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          input.job.id,
          input.job.attemptNumber,
          input.requestAt,
          input.responseAt,
          input.httpStatusCode,
          input.responseDurationMs,
          input.responseExcerpt,
          input.errorClassification,
          input.outcome,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async heartbeat(input: {
    workerId: string;
    concurrency: number;
    activeJobs: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO worker_heartbeats
         (worker_id, started_at, heartbeat_at, active, concurrency, active_jobs)
       VALUES ($1, now(), now(), true, $2, $3)
       ON CONFLICT (worker_id) DO UPDATE SET
         heartbeat_at = now(),
         active = true,
         concurrency = EXCLUDED.concurrency,
         active_jobs = EXCLUDED.active_jobs`,
      [input.workerId, input.concurrency, input.activeJobs],
    );
  }

  public async stopHeartbeat(workerId: string): Promise<void> {
    await this.pool.query(
      `UPDATE worker_heartbeats
       SET active = false, heartbeat_at = now(), active_jobs = 0
       WHERE worker_id = $1`,
      [workerId],
    );
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}

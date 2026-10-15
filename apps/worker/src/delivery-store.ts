import { randomUUID } from "node:crypto";

import { Pool, type PoolClient, type QueryResultRow } from "pg";

import type { WorkerConfig } from "./config.js";
import { EnvelopeKeyResolver } from "./crypto.js";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface DeliveryJob {
  id: string;
  eventId: string;
  projectId: string;
  eventType: string;
  payload: JsonValue;
  endpointId: string;
  endpointUrl: string;
  endpointSecretVersion: number;
  encryptedSecret: {
    ciphertext: string;
    iv: string;
    authTag: string;
    encryptionKeyVersion?: number;
  };
  encryptedStaticHeaders: Record<
    string,
    {
      ciphertext: string;
      iv: string;
      authTag: string;
      encryptionKeyVersion?: number;
    }
  >;
  deliveryKind: "event" | "dead_letter_alert";
  attemptNumber: number;
  leaseToken: string;
  sourceRequestId: string | null;
  traceparent: string | null;
  tracestate: string | null;
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
  claimDueDelivery(input: {
    leaseSeconds: number;
    maxInFlightPerEndpoint: number;
    maxInFlightPerProject: number;
  }): Promise<DeliveryJob | null>;
  recordAttempt(input: DeliveryAttemptInput): Promise<void>;
  heartbeat(input: {
    workerId: string;
    concurrency: number;
    activeJobs: number;
  }): Promise<void>;
  stopHeartbeat(workerId: string): Promise<void>;
  close(): Promise<void>;
  resolveEncryptionKey?(version: number): Promise<Buffer>;
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
    projectId: String(row.project_id),
    eventType: String(row.event_type),
    payload: row.payload as JsonValue,
    endpointId: String(row.endpoint_id),
    endpointUrl: String(row.endpoint_url),
    endpointSecretVersion: Number(row.endpoint_secret_version),
    encryptedSecret: {
      ciphertext: String(row.ciphertext),
      iv: String(row.iv),
      authTag: String(row.auth_tag),
      ...(row.encryption_key_version
        ? { encryptionKeyVersion: Number(row.encryption_key_version) }
        : {}),
    },
    encryptedStaticHeaders:
      row.endpoint_static_headers &&
      typeof row.endpoint_static_headers === "object"
        ? (row.endpoint_static_headers as DeliveryJob["encryptedStaticHeaders"])
        : {},
    deliveryKind: row.delivery_kind as DeliveryJob["deliveryKind"],
    attemptNumber: Number(row.attempt_number),
    leaseToken: String(row.lease_token),
    sourceRequestId: row.source_request_id
      ? String(row.source_request_id)
      : null,
    traceparent: row.traceparent ? String(row.traceparent) : null,
    tracestate: row.tracestate ? String(row.tracestate) : null,
  };
}

export class PgDeliveryStore implements DeliveryStore {
  private readonly pool: Pool;
  private readonly keyResolver?: EnvelopeKeyResolver;

  public constructor(databaseUrl: string, pool?: Pool, config?: WorkerConfig) {
    this.pool =
      pool ??
      new Pool({
        connectionString: databaseUrl,
        max: 10,
        connectionTimeoutMillis: 2_000,
        idleTimeoutMillis: 30_000,
      });
    if (config?.ENVELOPE_PROVIDER === "vault") {
      this.keyResolver = new EnvelopeKeyResolver(this.pool, config);
    }
  }

  public resolveEncryptionKey(version: number): Promise<Buffer> {
    if (!this.keyResolver) {
      return Promise.reject(
        new Error(
          `Encryption key version ${version} is unavailable in legacy mode`,
        ),
      );
    }
    return this.keyResolver.resolve(version);
  }

  public async claimDueDelivery(input: {
    leaseSeconds: number;
    maxInFlightPerEndpoint: number;
    maxInFlightPerProject: number;
  }): Promise<DeliveryJob | null> {
    // Recover leases before scanning. The claim transaction below still locks
    // the project quota row before counting occupancy, so this update cannot
    // allow two quota-aware workers to over-claim a project.
    await this.pool.query(
      `UPDATE deliveries
          SET status = CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE 'pending' END,
              lease_expires_at = NULL, lease_token = NULL,
              cancelled_at = CASE WHEN cancel_requested_at IS NOT NULL THEN COALESCE(cancelled_at, now()) ELSE cancelled_at END,
              completed_at = CASE WHEN cancel_requested_at IS NOT NULL THEN COALESCE(completed_at, now()) ELSE completed_at END,
              updated_at = now()
        WHERE status = 'in_flight' AND lease_expires_at <= now()`,
    );

    const candidates = await this.pool.query<DatabaseRow>(
      `SELECT d.id
         FROM deliveries d
         WHERE d.status = 'pending' AND d.next_attempt_at <= now()
         ORDER BY d.next_attempt_at, d.id
         LIMIT 100`,
    );

    // Each candidate gets its own transaction. This avoids holding a lock for
    // one project while looking for work in another project and keeps the
    // project -> endpoint lock order deadlock-free across workers.
    for (const candidate of candidates.rows) {
      const client = await this.pool.connect();
      const leaseToken = randomUUID();
      try {
        await client.query("BEGIN");
        const resource = await client.query<DatabaseRow>(
          `SELECT d.endpoint_id, e.project_id
             FROM deliveries d
             JOIN events e ON e.id = d.event_id
            WHERE d.id = $1`,
          [candidate.id],
        );
        const resourceRow = resource.rows[0];
        if (!resourceRow) {
          await client.query("COMMIT");
          continue;
        }
        const projectId = String(resourceRow.project_id);
        const endpointId = String(resourceRow.endpoint_id);

        await client.query(
          `INSERT INTO delivery_project_quota_locks (project_id)
           VALUES ($1) ON CONFLICT DO NOTHING`,
          [projectId],
        );
        await client.query(
          `INSERT INTO delivery_endpoint_quota_locks (endpoint_id)
           VALUES ($1) ON CONFLICT DO NOTHING`,
          [endpointId],
        );
        await client.query(
          `SELECT project_id
             FROM delivery_project_quota_locks
            WHERE project_id = $1
            FOR UPDATE`,
          [projectId],
        );
        await client.query(
          `SELECT endpoint_id
             FROM delivery_endpoint_quota_locks
            WHERE endpoint_id = $1
            FOR UPDATE`,
          [endpointId],
        );

        await client.query(
          `UPDATE deliveries d
              SET status = CASE WHEN d.cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE 'pending' END,
                  lease_expires_at = NULL, lease_token = NULL,
                  cancelled_at = CASE WHEN d.cancel_requested_at IS NOT NULL THEN COALESCE(d.cancelled_at, now()) ELSE d.cancelled_at END,
                  completed_at = CASE WHEN d.cancel_requested_at IS NOT NULL THEN COALESCE(d.completed_at, now()) ELSE d.completed_at END,
                  updated_at = now()
             FROM events e
            WHERE d.event_id = e.id
              AND e.project_id = $1
              AND d.status = 'in_flight'
              AND d.lease_expires_at <= now()`,
          [projectId],
        );

        const projectOccupancy = await client.query<{ in_flight: number }>(
          `SELECT COUNT(*)::integer AS in_flight
             FROM deliveries d
             JOIN events e ON e.id = d.event_id
            WHERE e.project_id = $1 AND d.status = 'in_flight'`,
          [projectId],
        );
        const endpointOccupancy = await client.query<{ in_flight: number }>(
          `SELECT COUNT(*)::integer AS in_flight
             FROM deliveries
            WHERE endpoint_id = $1 AND status = 'in_flight'`,
          [endpointId],
        );
        if (
          Number(projectOccupancy.rows[0]?.in_flight ?? 0) >=
            input.maxInFlightPerProject ||
          Number(endpointOccupancy.rows[0]?.in_flight ?? 0) >=
            input.maxInFlightPerEndpoint
        ) {
          await client.query("COMMIT");
          continue;
        }

        const claimable = await client.query<DatabaseRow>(
          `SELECT d.id
             FROM deliveries d
            WHERE d.id = $1
              AND d.status = 'pending'
              AND d.next_attempt_at <= now()
            FOR UPDATE SKIP LOCKED`,
          [candidate.id],
        );
        if (claimable.rowCount === 0) {
          await client.query("COMMIT");
          continue;
        }

        await client.query(
          `UPDATE deliveries
              SET status = 'in_flight',
                  attempt_count = attempt_count + 1,
                  lease_expires_at = now() + ($1::integer * interval '1 second'),
                  lease_token = $2::uuid,
                  updated_at = now()
            WHERE id = $3`,
          [input.leaseSeconds, leaseToken, candidate.id],
        );

        const job = await client.query<DatabaseRow>(
          `SELECT
             d.id,
             d.event_id,
             e.project_id,
             d.endpoint_id,
             d.endpoint_url,
             d.endpoint_secret_version,
             d.attempt_count AS attempt_number,
             d.lease_token,
             d.endpoint_static_headers,
              d.delivery_kind,
              e.event_type,
              e.payload,
              e.source_request_id,
              e.traceparent,
              e.tracestate,
              s.ciphertext,
              s.iv,
              s.auth_tag,
              s.encryption_key_version
           FROM deliveries d
           JOIN events e ON e.id = d.event_id
           JOIN endpoint_secrets s
             ON s.endpoint_id = d.endpoint_id
            AND s.version = d.endpoint_secret_version
          WHERE d.id = $1 AND d.lease_token = $2::uuid`,
          [candidate.id, leaseToken],
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
    return null;
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
         SET status = CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE $2 END,
             next_attempt_at = COALESCE($3, next_attempt_at),
             lease_expires_at = NULL,
             lease_token = NULL,
             last_http_status_code = $4,
             last_error = $5,
             updated_at = now(),
             cancelled_at = CASE WHEN cancel_requested_at IS NOT NULL THEN COALESCE(cancelled_at, now()) ELSE cancelled_at END,
             dead_lettered_at = CASE WHEN $2 = 'failed' AND cancel_requested_at IS NULL THEN COALESCE(dead_lettered_at, now()) ELSE dead_lettered_at END,
             dead_letter_reason = CASE WHEN $2 = 'failed' AND cancel_requested_at IS NULL THEN COALESCE(dead_letter_reason, $7) ELSE dead_letter_reason END,
             completed_at = CASE
               WHEN cancel_requested_at IS NOT NULL OR $2 IN ('delivered', 'failed') THEN now()
               ELSE NULL
             END
         WHERE id = $1 AND status = 'in_flight' AND lease_token = $6::uuid
         RETURNING id, event_id, delivery_kind, status, attempt_count`,
        [
          input.job.id,
          status,
          input.nextAttemptAt,
          input.httpStatusCode,
          input.lastError,
          input.job.leaseToken,
          input.lastError ?? input.errorClassification,
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
      const updatedRow = updated.rows[0]!;
      if (
        updatedRow.status === "failed" &&
        updatedRow.delivery_kind === "event"
      ) {
        const alert = await client.query<DatabaseRow>(
          `SELECT e.project_id, e.event_type, d.endpoint_id,
                  d.attempt_count, d.last_http_status_code,
                  a.endpoint_id AS alert_endpoint_id,
                  alert_ep.url AS alert_endpoint_url,
                  alert_ep.current_secret_version AS alert_secret_version,
                  alert_ep.static_headers AS alert_static_headers
           FROM deliveries d
           JOIN events e ON e.id = d.event_id
           JOIN project_dead_letter_alerts a ON a.project_id = e.project_id
           JOIN endpoints alert_ep ON alert_ep.id = a.endpoint_id
           WHERE d.id = $1 AND alert_ep.status = 'active'`,
          [input.job.id],
        );
        const alertRow = alert.rows[0];
        if (alertRow) {
          const internalEvent = await client.query<DatabaseRow>(
            `INSERT INTO events (project_id, event_type, payload, is_internal)
             VALUES ($1, 'hookforge.delivery.dead_lettered', $2, true)
             RETURNING id`,
            [
              alertRow.project_id,
              {
                deliveryId: input.job.id,
                eventId: input.job.eventId,
                eventType: input.job.eventType,
                endpointId: alertRow.endpoint_id,
                attemptCount: Number(alertRow.attempt_count),
                httpStatusCode: alertRow.last_http_status_code
                  ? Number(alertRow.last_http_status_code)
                  : null,
                reason: input.lastError ?? input.errorClassification,
              },
            ],
          );
          await client.query(
            `INSERT INTO deliveries
               (event_id, endpoint_id, endpoint_url, endpoint_secret_version,
                endpoint_static_headers, delivery_kind, alert_source_delivery_id)
             VALUES ($1, $2, $3, $4, $5, 'dead_letter_alert', $6)
              ON CONFLICT (alert_source_delivery_id) WHERE alert_source_delivery_id IS NOT NULL DO NOTHING`,
            [
              internalEvent.rows[0]!.id,
              alertRow.alert_endpoint_id,
              alertRow.alert_endpoint_url,
              alertRow.alert_secret_version,
              alertRow.alert_static_headers,
              input.job.id,
            ],
          );
        }
      }
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

import { randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import { conflict, notFound } from "./errors.js";

export type EndpointStatus = "active" | "paused" | "disabled";
export type DeliveryKind = "event" | "dead_letter_alert";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  expiresAt: string;
  revokedAt: string | null;
  user: UserRecord;
}

export interface ProjectRecord {
  id: string;
  ownerId: string;
  name: string;
  publicIdentifier: string;
  createdAt: string;
  updatedAt: string;
}

export interface EndpointRecord {
  id: string;
  projectId: string;
  name: string;
  url: string;
  status: EndpointStatus;
  currentSecretVersion: number;
  eventPatterns: string[];
  staticHeaderNames: string[];
  lastSuccessfulDeliveryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EventRecord {
  id: string;
  projectId: string;
  eventType: string;
  payload: JsonValue;
  createdAt: string;
}

export interface EventSummary {
  id: string;
  projectId: string;
  eventType: string;
  createdAt: string;
}

export interface EventCursor {
  // Canonical UTC timestamp with all six PostgreSQL fractional digits.
  createdAt: string;
  id: string;
}

export interface EventListFilter {
  limit: number;
  eventType?: string;
  cursor?: EventCursor;
}

export interface EventListResult {
  events: EventSummary[];
  nextCursor: EventCursor | null;
}

export interface ProjectOverview {
  events: number;
  endpoints: {
    active: number;
    paused: number;
    disabled: number;
  };
  deliveries: {
    pending: number;
    in_flight: number;
    delivered: number;
    failed: number;
  };
}

export interface OperationalMetrics {
  queueBacklog: {
    pending: number;
    inFlight: number;
  };
  deliveryStatusCounts: {
    pending: number;
    inFlight: number;
    delivered: number;
    failed: number;
    cancelled: number;
  };
  deliveryLatencyMilliseconds: {
    count: number;
    average: number;
  };
  workers: {
    active: number;
    configuredConcurrency: number;
    activeJobs: number;
    stale: number;
  };
}

export interface IngestEventResult {
  event: EventRecord;
  deliveryCount: number;
  deduplicated: boolean;
}

export type DeliveryStatus =
  "pending" | "in_flight" | "delivered" | "failed" | "cancelled";

export interface DeliveryCursor {
  createdAt: string;
  id: string;
}

export interface DeliverySummary {
  id: string;
  projectId: string;
  eventId: string;
  eventType: string;
  endpointId: string;
  endpointName: string;
  endpointUrl: string;
  status: DeliveryStatus;
  attemptCount: number;
  nextAttemptAt: string;
  lastHttpStatusCode: number | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  replayOfDeliveryId: string | null;
  replayNumber: number;
  deliveryKind: DeliveryKind;
  cancelledAt: string | null;
  deadLetteredAt: string | null;
  deadLetterReason: string | null;
}

export interface DeliveryAttemptRecord {
  id: string;
  attemptNumber: number;
  requestAt: string;
  responseAt: string | null;
  httpStatusCode: number | null;
  responseDurationMs: number | null;
  responseExcerpt: string | null;
  errorClassification: string | null;
  outcome: "success" | "retry" | "failed";
}

export interface DeliveryDetail {
  delivery: DeliverySummary;
  eventPayload: JsonValue;
  attempts: DeliveryAttemptRecord[];
}

export interface DeliveryListFilter {
  limit: number;
  status?: DeliveryStatus;
  endpointId?: string;
  eventType?: string;
  deliveryKind?: DeliveryKind;
  from?: Date;
  to?: Date;
  cursor?: DeliveryCursor;
}

export interface BulkDeliveryResult {
  operationId: string;
  requested: number;
  processed: number;
  deliveries: DeliverySummary[];
  skipped: Array<{ deliveryId: string; reason: string }>;
}

export interface AlertDestination {
  endpointId: string;
  endpointName: string;
  endpointUrl: string;
  updatedAt: string;
}

export interface EncryptedHeaderMap {
  [name: string]: EncryptedSecretRecord;
}

export interface DeliveryListResult {
  deliveries: DeliverySummary[];
  nextCursor: DeliveryCursor | null;
}

export interface EncryptedSecretRecord {
  ciphertext: string;
  iv: string;
  authTag: string;
  encryptionKeyVersion?: number;
}

export interface AuditContext {
  actorType: "user" | "system";
  actorId?: string;
  requestId?: string;
  traceId?: string;
}

export interface HookForgeStore {
  createUser(input: {
    email: string;
    emailNormalized: string;
    passwordHash: string;
  }): Promise<UserRecord>;
  findUserByEmail(emailNormalized: string): Promise<UserRecord | null>;
  createSession(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<{ id: string; expiresAt: string }>;
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  revokeSession(sessionId: string): Promise<void>;
  createProject(input: {
    ownerId: string;
    name: string;
    nameNormalized: string;
    publicIdentifier: string;
  }): Promise<ProjectRecord>;
  listProjects(ownerId: string, limit: number): Promise<ProjectRecord[]>;
  getProject(ownerId: string, projectId: string): Promise<ProjectRecord | null>;
  getProjectOverview(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectOverview | null>;
  getOperationalMetrics(): Promise<OperationalMetrics>;
  createEndpoint(input: {
    ownerId: string;
    projectId: string;
    name: string;
    nameNormalized: string;
    url: string;
    secret: EncryptedSecretRecord;
    staticHeaders: EncryptedHeaderMap;
    eventPatterns: string[];
    audit?: AuditContext;
  }): Promise<EndpointRecord>;
  listEndpoints(
    ownerId: string,
    projectId: string,
    limit: number,
  ): Promise<EndpointRecord[]>;
  getEndpoint(
    ownerId: string,
    projectId: string,
    endpointId: string,
  ): Promise<EndpointRecord | null>;
  updateEndpoint(
    ownerId: string,
    projectId: string,
    endpointId: string,
    input: {
      name?: string;
      nameNormalized?: string;
      url?: string;
      staticHeaders?: EncryptedHeaderMap;
    },
    audit?: AuditContext,
  ): Promise<EndpointRecord | null>;
  setEndpointStatus(
    ownerId: string,
    projectId: string,
    endpointId: string,
    status: EndpointStatus,
  ): Promise<EndpointRecord | null>;
  rotateEndpointSecret(
    ownerId: string,
    projectId: string,
    endpointId: string,
    secret: EncryptedSecretRecord,
    audit?: AuditContext,
  ): Promise<EndpointRecord | null>;
  listEndpointSubscriptions(
    ownerId: string,
    projectId: string,
    endpointId: string,
  ): Promise<string[] | null>;
  replaceEndpointSubscriptions(
    ownerId: string,
    projectId: string,
    endpointId: string,
    patterns: string[],
  ): Promise<string[] | null>;
  ingestEvent(input: {
    ownerId: string;
    projectId: string;
    eventType: string;
    payload: JsonValue;
    idempotencyKey?: string;
    requestHash: string;
    sourceRequestId?: string;
    traceparent?: string;
    tracestate?: string;
  }): Promise<IngestEventResult>;
  listEvents(
    ownerId: string,
    projectId: string,
    filter: EventListFilter,
  ): Promise<EventListResult | null>;
  listDeliveries(
    ownerId: string,
    projectId: string,
    filter: DeliveryListFilter,
  ): Promise<DeliveryListResult>;
  getDelivery(
    ownerId: string,
    projectId: string,
    deliveryId: string,
  ): Promise<DeliveryDetail | null>;
  replayDelivery(
    ownerId: string,
    projectId: string,
    deliveryId: string,
  ): Promise<DeliverySummary | null>;
  bulkReplayDeliveries(input: {
    ownerId: string;
    projectId: string;
    deliveryIds: string[];
    idempotencyKey: string;
    requestHash: string;
  }): Promise<BulkDeliveryResult | null>;
  bulkCancelDeliveries(input: {
    ownerId: string;
    projectId: string;
    deliveryIds: string[];
    idempotencyKey: string;
    requestHash: string;
    reason: string;
  }): Promise<BulkDeliveryResult | null>;
  getDeadLetterAlert(
    ownerId: string,
    projectId: string,
  ): Promise<AlertDestination | null>;
  setDeadLetterAlert(input: {
    ownerId: string;
    projectId: string;
    endpointId: string;
  }): Promise<AlertDestination | null>;
  clearDeadLetterAlert(ownerId: string, projectId: string): Promise<boolean>;
  reconcileExpiredDeliveries(
    ownerId: string,
    projectId: string,
  ): Promise<number>;
}

type DatabaseRow = QueryResultRow & Record<string, unknown>;

function mapUser(row: DatabaseRow): UserRecord {
  return {
    id: String(row.id),
    email: String(row.email),
    passwordHash: String(row.password_hash),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function mapProject(row: DatabaseRow): ProjectRecord {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    name: String(row.name),
    publicIdentifier: String(row.public_identifier),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function encryptedHeaderNames(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).sort();
}

function mapEndpoint(row: DatabaseRow): EndpointRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    url: String(row.url),
    status: row.status as EndpointStatus,
    currentSecretVersion: Number(row.current_secret_version),
    eventPatterns: Array.isArray(row.event_patterns)
      ? row.event_patterns.map(String)
      : [],
    staticHeaderNames: encryptedHeaderNames(row.static_headers),
    lastSuccessfulDeliveryAt: row.last_successful_delivery_at
      ? new Date(String(row.last_successful_delivery_at)).toISOString()
      : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function mapEvent(row: DatabaseRow): EventRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    eventType: String(row.event_type),
    payload: row.payload as JsonValue,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

function mapEventSummary(row: DatabaseRow): EventSummary {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    eventType: String(row.event_type),
    createdAt: new Date(String(row.created_at_cursor)).toISOString(),
  };
}

function dateOrNull(value: unknown): string | null {
  return value ? new Date(String(value)).toISOString() : null;
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function mapDelivery(row: DatabaseRow): DeliverySummary {
  return {
    id: String(row.delivery_id),
    projectId: String(row.project_id),
    eventId: String(row.event_id),
    eventType: String(row.event_type),
    endpointId: String(row.endpoint_id),
    endpointName: String(row.endpoint_name),
    endpointUrl: String(row.endpoint_url),
    status: row.status as DeliveryStatus,
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: new Date(String(row.next_attempt_at)).toISOString(),
    lastHttpStatusCode: numberOrNull(row.last_http_status_code),
    lastError: row.last_error ? String(row.last_error) : null,
    createdAt: new Date(String(row.delivery_created_at)).toISOString(),
    updatedAt: new Date(String(row.delivery_updated_at)).toISOString(),
    completedAt: dateOrNull(row.completed_at),
    replayOfDeliveryId: row.replay_of_delivery_id
      ? String(row.replay_of_delivery_id)
      : null,
    replayNumber: Number(row.replay_number),
    deliveryKind: row.delivery_kind as DeliveryKind,
    cancelledAt: dateOrNull(row.cancelled_at),
    deadLetteredAt: dateOrNull(row.dead_lettered_at),
    deadLetterReason: row.dead_letter_reason
      ? String(row.dead_letter_reason)
      : null,
  };
}

function mapAttempt(row: DatabaseRow): DeliveryAttemptRecord {
  return {
    id: String(row.id),
    attemptNumber: Number(row.attempt_number),
    requestAt: new Date(String(row.request_at)).toISOString(),
    responseAt: dateOrNull(row.response_at),
    httpStatusCode: numberOrNull(row.http_status_code),
    responseDurationMs: numberOrNull(row.response_duration_ms),
    responseExcerpt: row.response_excerpt ? String(row.response_excerpt) : null,
    errorClassification: row.error_classification
      ? String(row.error_classification)
      : null,
    outcome: row.outcome as DeliveryAttemptRecord["outcome"],
  };
}

const deliveryColumns = `
  d.id AS delivery_id,
  e.project_id,
  d.event_id,
  e.event_type,
  d.endpoint_id,
  ep.name AS endpoint_name,
  d.endpoint_url,
  d.status,
  d.attempt_count,
  d.next_attempt_at,
  d.last_http_status_code,
  d.last_error,
  d.created_at AS delivery_created_at,
  d.updated_at AS delivery_updated_at,
  d.completed_at,
  d.replay_of_delivery_id,
  d.replay_number,
  d.delivery_kind,
  d.cancelled_at,
  d.dead_lettered_at,
  d.dead_letter_reason`;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transaction error.
  }
}

async function recordAudit(
  client: PoolClient,
  input: {
    action: string;
    audit?: AuditContext;
    projectId?: string;
    endpointId?: string;
    provider?: string;
    encryptionKeyVersion?: number;
    success?: boolean;
    metadata?: Record<string, JsonValue>;
  },
): Promise<void> {
  if (!input.audit) return;
  await client.query(
    `INSERT INTO audit_events
       (action, actor_type, actor_id, project_id, endpoint_id,
        request_id, trace_id, provider, encryption_key_version, success, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.action,
      input.audit.actorType,
      input.audit.actorId ?? null,
      input.projectId ?? null,
      input.endpointId ?? null,
      input.audit.requestId ?? null,
      input.audit.traceId ?? null,
      input.provider ?? null,
      input.encryptionKeyVersion ?? null,
      input.success ?? true,
      input.metadata ?? {},
    ],
  );
}

export class PgStore implements HookForgeStore {
  public constructor(private readonly pool: Pool) {}

  public async createUser(input: {
    email: string;
    emailNormalized: string;
    passwordHash: string;
  }): Promise<UserRecord> {
    try {
      const result = await this.pool.query<DatabaseRow>(
        `INSERT INTO users (email, email_normalized, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, email, password_hash, created_at, updated_at`,
        [input.email, input.emailNormalized, input.passwordHash],
      );
      return mapUser(result.rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict(
          "EMAIL_TAKEN",
          "An account with this email already exists",
        );
      }
      throw error;
    }
  }

  public async findUserByEmail(
    emailNormalized: string,
  ): Promise<UserRecord | null> {
    const result = await this.pool.query<DatabaseRow>(
      `SELECT id, email, password_hash, created_at, updated_at
       FROM users WHERE email_normalized = $1`,
      [emailNormalized],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  public async createSession(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<{ id: string; expiresAt: string }> {
    const result = await this.pool.query<DatabaseRow>(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id, expires_at`,
      [input.userId, input.tokenHash, input.expiresAt],
    );
    const row = result.rows[0]!;
    return {
      id: String(row.id),
      expiresAt: new Date(String(row.expires_at)).toISOString(),
    };
  }

  public async findSessionByTokenHash(
    tokenHash: string,
  ): Promise<SessionRecord | null> {
    const result = await this.pool.query<DatabaseRow>(
      `SELECT
         s.id AS session_id,
         s.user_id,
         s.expires_at,
         s.revoked_at,
         u.id,
         u.email,
         u.password_hash,
         u.created_at,
         u.updated_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > now()`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    await this.pool.query(
      "UPDATE sessions SET last_seen_at = now() WHERE id = $1",
      [row.session_id],
    );

    return {
      id: String(row.session_id),
      userId: String(row.user_id),
      expiresAt: new Date(String(row.expires_at)).toISOString(),
      revokedAt: row.revoked_at
        ? new Date(String(row.revoked_at)).toISOString()
        : null,
      user: mapUser(row),
    };
  }

  public async revokeSession(sessionId: string): Promise<void> {
    await this.pool.query(
      "UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1",
      [sessionId],
    );
  }

  public async createProject(input: {
    ownerId: string;
    name: string;
    nameNormalized: string;
    publicIdentifier: string;
  }): Promise<ProjectRecord> {
    try {
      const result = await this.pool.query<DatabaseRow>(
        `INSERT INTO projects (owner_id, name, name_normalized, public_identifier)
         VALUES ($1, $2, $3, $4)
         RETURNING id, owner_id, name, public_identifier, created_at, updated_at`,
        [
          input.ownerId,
          input.name,
          input.nameNormalized,
          input.publicIdentifier,
        ],
      );
      return mapProject(result.rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict(
          "PROJECT_NAME_TAKEN",
          "You already have a project with this name",
        );
      }
      throw error;
    }
  }

  public async listProjects(
    ownerId: string,
    limit: number,
  ): Promise<ProjectRecord[]> {
    const result = await this.pool.query<DatabaseRow>(
      `SELECT id, owner_id, name, public_identifier, created_at, updated_at
       FROM projects
       WHERE owner_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [ownerId, limit],
    );
    return result.rows.map(mapProject);
  }

  public async getProject(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectRecord | null> {
    const result = await this.pool.query<DatabaseRow>(
      `SELECT id, owner_id, name, public_identifier, created_at, updated_at
       FROM projects WHERE id = $1 AND owner_id = $2`,
      [projectId, ownerId],
    );
    return result.rows[0] ? mapProject(result.rows[0]) : null;
  }

  public async getProjectOverview(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectOverview | null> {
    // Keep each metric independent so endpoint/event/delivery joins cannot
    // multiply rows before they are counted.
    const result = await this.pool.query<DatabaseRow>(
      `SELECT
          (SELECT COUNT(*) FROM events e WHERE e.project_id = p.id AND e.is_internal = false) AS events_count,
         ep.endpoints_active, ep.endpoints_paused, ep.endpoints_disabled,
         d.deliveries_pending, d.deliveries_in_flight,
          d.deliveries_delivered, d.deliveries_failed
       FROM projects p
       CROSS JOIN LATERAL (
         SELECT COUNT(*) FILTER (WHERE status = 'active') AS endpoints_active,
                COUNT(*) FILTER (WHERE status = 'paused') AS endpoints_paused,
                COUNT(*) FILTER (WHERE status = 'disabled') AS endpoints_disabled
         FROM endpoints WHERE project_id = p.id
       ) ep
       CROSS JOIN LATERAL (
         SELECT COUNT(*) FILTER (WHERE d.status = 'pending') AS deliveries_pending,
                COUNT(*) FILTER (WHERE d.status = 'in_flight') AS deliveries_in_flight,
                COUNT(*) FILTER (WHERE d.status = 'delivered') AS deliveries_delivered,
                 COUNT(*) FILTER (WHERE d.status = 'failed') AS deliveries_failed
         FROM deliveries d
         JOIN events e ON e.id = d.event_id
          WHERE e.project_id = p.id AND d.delivery_kind = 'event'
       ) d
       WHERE p.id = $1 AND p.owner_id = $2`,
      [projectId, ownerId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      events: Number(row.events_count),
      endpoints: {
        active: Number(row.endpoints_active),
        paused: Number(row.endpoints_paused),
        disabled: Number(row.endpoints_disabled),
      },
      deliveries: {
        pending: Number(row.deliveries_pending),
        in_flight: Number(row.deliveries_in_flight),
        delivered: Number(row.deliveries_delivered),
        failed: Number(row.deliveries_failed),
      },
    };
  }

  public async getOperationalMetrics(): Promise<OperationalMetrics> {
    const result = await this.pool.query<DatabaseRow>(
      `SELECT
         (SELECT COUNT(*) FILTER (WHERE status = 'pending') FROM deliveries) AS pending,
         (SELECT COUNT(*) FILTER (WHERE status = 'in_flight') FROM deliveries) AS in_flight,
         (SELECT COUNT(*) FILTER (WHERE status = 'delivered') FROM deliveries) AS delivered,
          (SELECT COUNT(*) FILTER (WHERE status = 'failed') FROM deliveries WHERE delivery_kind = 'event') AS failed,
          (SELECT COUNT(*) FILTER (WHERE status = 'cancelled') FROM deliveries WHERE delivery_kind = 'event') AS cancelled,
         (SELECT COUNT(*) FROM delivery_attempts
          WHERE response_duration_ms IS NOT NULL) AS latency_count,
         (SELECT COALESCE(AVG(response_duration_ms), 0) FROM delivery_attempts
          WHERE response_duration_ms IS NOT NULL) AS latency_average,
         (SELECT COUNT(*) FROM worker_heartbeats
          WHERE active = true
            AND heartbeat_at > now() - interval '30 seconds') AS active_workers,
         (SELECT COALESCE(SUM(concurrency), 0) FROM worker_heartbeats
          WHERE active = true
            AND heartbeat_at > now() - interval '30 seconds') AS worker_concurrency,
         (SELECT COALESCE(SUM(active_jobs), 0) FROM worker_heartbeats
          WHERE active = true
            AND heartbeat_at > now() - interval '30 seconds') AS active_jobs,
         (SELECT COUNT(*) FROM worker_heartbeats
          WHERE active = true
            AND heartbeat_at <= now() - interval '30 seconds') AS stale_workers`,
    );
    const row = result.rows[0]!;
    return {
      queueBacklog: {
        pending: Number(row.pending),
        inFlight: Number(row.in_flight),
      },
      deliveryStatusCounts: {
        pending: Number(row.pending),
        inFlight: Number(row.in_flight),
        delivered: Number(row.delivered),
        failed: Number(row.failed),
        cancelled: Number(row.cancelled),
      },
      deliveryLatencyMilliseconds: {
        count: Number(row.latency_count),
        average: Number(row.latency_average),
      },
      workers: {
        active: Number(row.active_workers),
        configuredConcurrency: Number(row.worker_concurrency),
        activeJobs: Number(row.active_jobs),
        stale: Number(row.stale_workers),
      },
    };
  }

  public async ingestEvent(input: {
    ownerId: string;
    projectId: string;
    eventType: string;
    payload: JsonValue;
    idempotencyKey?: string;
    requestHash: string;
    sourceRequestId?: string;
    traceparent?: string;
    tracestate?: string;
  }): Promise<IngestEventResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const project = await client.query<DatabaseRow>(
        "SELECT id FROM projects WHERE id = $1 AND owner_id = $2 FOR UPDATE",
        [input.projectId, input.ownerId],
      );
      if (project.rowCount === 0) {
        throw notFound();
      }

      if (input.idempotencyKey !== undefined) {
        const existing = await client.query<DatabaseRow>(
          `SELECT request_hash, event_id
           FROM event_idempotency_keys
           WHERE project_id = $1 AND idempotency_key = $2
           FOR UPDATE`,
          [input.projectId, input.idempotencyKey],
        );
        const existingRow = existing.rows[0];
        if (existingRow) {
          if (String(existingRow.request_hash) !== input.requestHash) {
            throw conflict(
              "IDEMPOTENCY_KEY_REUSED",
              "Idempotency-Key was already used with a different event",
            );
          }
          const event = await client.query<DatabaseRow>(
            `SELECT id, project_id, event_type, payload, created_at
             FROM events WHERE id = $1`,
            [existingRow.event_id],
          );
          const deliveries = await client.query<{ count: string }>(
            "SELECT COUNT(*)::text AS count FROM deliveries WHERE event_id = $1",
            [existingRow.event_id],
          );
          await client.query("COMMIT");
          return {
            event: mapEvent(event.rows[0]!),
            deliveryCount: Number(deliveries.rows[0]?.count ?? 0),
            deduplicated: true,
          };
        }
      }

      const event = await client.query<DatabaseRow>(
        `INSERT INTO events
           (project_id, event_type, payload, source_request_id, traceparent, tracestate)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, project_id, event_type, payload, created_at`,
        [
          input.projectId,
          input.eventType,
          input.payload,
          input.sourceRequestId ?? null,
          input.traceparent ?? null,
          input.tracestate ?? null,
        ],
      );
      const eventRow = event.rows[0]!;

      if (input.idempotencyKey !== undefined) {
        await client.query(
          `INSERT INTO event_idempotency_keys
             (project_id, idempotency_key, request_hash, event_id)
           VALUES ($1, $2, $3, $4)`,
          [
            input.projectId,
            input.idempotencyKey,
            input.requestHash,
            eventRow.id,
          ],
        );
      }

      const deliveries = await client.query(
        `INSERT INTO deliveries
            (event_id, endpoint_id, endpoint_url, endpoint_secret_version,
             endpoint_static_headers)
          SELECT $1, e.id, e.url, e.current_secret_version
                 , e.static_headers
          FROM endpoints e
          WHERE e.project_id = $2 AND e.status = 'active'
            AND EXISTS (
              SELECT 1 FROM endpoint_subscriptions s
              WHERE s.endpoint_id = e.id
                AND (s.pattern = '*' OR
                     (right(s.pattern, 1) = '*' AND
                      starts_with($3, left(s.pattern, length(s.pattern) - 1))) OR
                     s.pattern = $3)
            )
          ORDER BY e.id
          FOR SHARE
          RETURNING id`,
        [eventRow.id, input.projectId, input.eventType],
      );
      await client.query("COMMIT");
      return {
        event: mapEvent(eventRow),
        deliveryCount: deliveries.rowCount ?? 0,
        deduplicated: false,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async listEvents(
    ownerId: string,
    projectId: string,
    filter: EventListFilter,
  ): Promise<EventListResult | null> {
    const project = await this.getProject(ownerId, projectId);
    if (!project) {
      return null;
    }

    const values: unknown[] = [projectId, ownerId];
    const conditions = [
      "e.project_id = $1",
      "p.owner_id = $2",
      "e.is_internal = false",
    ];
    const addValue = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };

    if (filter.eventType) {
      conditions.push(`e.event_type = ${addValue(filter.eventType)}`);
    }
    if (filter.cursor) {
      const cursorCreatedAt = addValue(filter.cursor.createdAt);
      const cursorId = addValue(filter.cursor.id);
      conditions.push(
        `(e.created_at, e.id) < (${cursorCreatedAt}::timestamptz, ${cursorId}::uuid)`,
      );
    }

    const limitParameter = addValue(filter.limit + 1);
    const result = await this.pool.query<DatabaseRow>(
      // Text bypasses pg's Date parser, which truncates microseconds. Never
      // derive the cursor from the display timestamp in mapEventSummary.
      `SELECT e.id, e.project_id, e.event_type,
              to_char(e.created_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
       FROM events e
       JOIN projects p ON p.id = e.project_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ${limitParameter}`,
      values,
    );
    const hasMore = result.rows.length > filter.limit;
    const rows = hasMore ? result.rows.slice(0, filter.limit) : result.rows;
    const last = rows.at(-1);
    return {
      events: rows.map(mapEventSummary),
      nextCursor:
        hasMore && last
          ? {
              createdAt: String(last.created_at_cursor),
              id: String(last.id),
            }
          : null,
    };
  }

  public async createEndpoint(input: {
    ownerId: string;
    projectId: string;
    name: string;
    nameNormalized: string;
    url: string;
    secret: EncryptedSecretRecord;
    staticHeaders: EncryptedHeaderMap;
    eventPatterns: string[];
    audit?: AuditContext;
  }): Promise<EndpointRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const project = await client.query<DatabaseRow>(
        "SELECT id FROM projects WHERE id = $1 AND owner_id = $2 FOR SHARE",
        [input.projectId, input.ownerId],
      );
      if (project.rowCount === 0) {
        throw notFound();
      }

      const endpoint = await client.query<DatabaseRow>(
        `INSERT INTO endpoints
           (project_id, name, name_normalized, url, static_headers)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, project_id, name, url, status, current_secret_version,
                   static_headers, last_successful_delivery_at, created_at, updated_at`,
        [
          input.projectId,
          input.name,
          input.nameNormalized,
          input.url,
          input.staticHeaders,
        ],
      );
      const row = endpoint.rows[0]!;
      await client.query(
        `INSERT INTO endpoint_secrets
           (endpoint_id, version, ciphertext, iv, auth_tag, encryption_key_version)
         VALUES ($1, 1, $2, $3, $4, $5)`,
        [
          row.id,
          input.secret.ciphertext,
          input.secret.iv,
          input.secret.authTag,
          input.secret.encryptionKeyVersion ?? null,
        ],
      );
      for (const pattern of input.eventPatterns) {
        await client.query(
          `INSERT INTO endpoint_subscriptions (endpoint_id, pattern)
           VALUES ($1, $2)`,
          [row.id, pattern],
        );
      }
      if (input.audit) {
        await recordAudit(client, {
          action: "endpoint.secret.created",
          audit: input.audit,
          projectId: input.projectId,
          endpointId: String(row.id),
          provider: input.secret.encryptionKeyVersion ? "vault" : "legacy",
          ...(input.secret.encryptionKeyVersion === undefined
            ? {}
            : { encryptionKeyVersion: input.secret.encryptionKeyVersion }),
          metadata: {
            staticHeaderCount: Object.keys(input.staticHeaders).length,
          },
        });
      }
      row.event_patterns = input.eventPatterns;
      await client.query("COMMIT");
      return mapEndpoint(row);
    } catch (error) {
      await rollback(client);
      if (isUniqueViolation(error)) {
        throw conflict(
          "ENDPOINT_NAME_TAKEN",
          "This project already has an endpoint with this name",
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  public async listEndpoints(
    ownerId: string,
    projectId: string,
    limit: number,
  ): Promise<EndpointRecord[]> {
    const result = await this.pool.query<DatabaseRow>(
      `SELECT e.id, e.project_id, e.name, e.url, e.status,
               e.current_secret_version, e.static_headers,
               e.last_successful_delivery_at, e.created_at, e.updated_at,
               (SELECT COALESCE(array_agg(s.pattern ORDER BY s.pattern), ARRAY[]::text[])
                FROM endpoint_subscriptions s WHERE s.endpoint_id = e.id) AS event_patterns
       FROM endpoints e
       JOIN projects p ON p.id = e.project_id
       WHERE e.project_id = $1 AND p.owner_id = $2
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT $3`,
      [projectId, ownerId, limit],
    );
    return result.rows.map(mapEndpoint);
  }

  public async getEndpoint(
    ownerId: string,
    projectId: string,
    endpointId: string,
  ): Promise<EndpointRecord | null> {
    const result = await this.pool.query<DatabaseRow>(
      `SELECT e.id, e.project_id, e.name, e.url, e.status,
               e.current_secret_version, e.static_headers,
               e.last_successful_delivery_at, e.created_at, e.updated_at,
               (SELECT COALESCE(array_agg(s.pattern ORDER BY s.pattern), ARRAY[]::text[])
                FROM endpoint_subscriptions s WHERE s.endpoint_id = e.id) AS event_patterns
       FROM endpoints e
       JOIN projects p ON p.id = e.project_id
       WHERE e.id = $1 AND e.project_id = $2 AND p.owner_id = $3`,
      [endpointId, projectId, ownerId],
    );
    return result.rows[0] ? mapEndpoint(result.rows[0]) : null;
  }

  public async updateEndpoint(
    ownerId: string,
    projectId: string,
    endpointId: string,
    input: {
      name?: string;
      nameNormalized?: string;
      url?: string;
      staticHeaders?: EncryptedHeaderMap;
    },
    audit?: AuditContext,
  ): Promise<EndpointRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<DatabaseRow>(
        `UPDATE endpoints e
         SET name = COALESCE($4, e.name),
             name_normalized = COALESCE($5, e.name_normalized),
             url = COALESCE($6, e.url),
             static_headers = COALESCE($7, e.static_headers),
             updated_at = now()
         FROM projects p
         WHERE e.id = $1 AND e.project_id = $2 AND p.id = e.project_id
           AND p.owner_id = $3
         RETURNING e.id, e.project_id, e.name, e.url, e.status,
                    e.current_secret_version, e.static_headers,
                    e.last_successful_delivery_at, e.created_at, e.updated_at`,
        [
          endpointId,
          projectId,
          ownerId,
          input.name ?? null,
          input.nameNormalized ?? null,
          input.url ?? null,
          input.staticHeaders ?? null,
        ],
      );
      if (!result.rows[0]) {
        await client.query("ROLLBACK");
        return null;
      }
      if (input.staticHeaders && audit) {
        await client.query(
          `INSERT INTO audit_events
             (action, actor_type, actor_id, project_id, endpoint_id,
              request_id, trace_id, provider, success, metadata)
           VALUES ('endpoint.static_headers.updated', $1, $2, $3, $4, $5, $6, $7, true, $8)`,
          [
            audit.actorType,
            audit.actorId ?? null,
            projectId,
            endpointId,
            audit.requestId ?? null,
            audit.traceId ?? null,
            Object.values(input.staticHeaders).some(
              (header) => header.encryptionKeyVersion !== undefined,
            )
              ? "vault"
              : "legacy",
            { staticHeaderCount: Object.keys(input.staticHeaders).length },
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
    return this.getEndpoint(ownerId, projectId, endpointId);
  }

  public async setEndpointStatus(
    ownerId: string,
    projectId: string,
    endpointId: string,
    status: EndpointStatus,
  ): Promise<EndpointRecord | null> {
    const result = await this.pool.query<DatabaseRow>(
      `UPDATE endpoints e
       SET status = $4, updated_at = now()
       FROM projects p
       WHERE e.id = $1 AND e.project_id = $2 AND p.id = e.project_id
         AND p.owner_id = $3
        RETURNING e.id, e.project_id, e.name, e.url, e.status,
                  e.current_secret_version, e.static_headers,
                  e.last_successful_delivery_at, e.created_at, e.updated_at`,
      [endpointId, projectId, ownerId, status],
    );
    return result.rows[0]
      ? this.getEndpoint(ownerId, projectId, endpointId)
      : null;
  }

  public async rotateEndpointSecret(
    ownerId: string,
    projectId: string,
    endpointId: string,
    secret: EncryptedSecretRecord,
    audit?: AuditContext,
  ): Promise<EndpointRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const endpoint = await client.query<DatabaseRow>(
        `SELECT e.id, e.project_id, e.name, e.url, e.status,
                e.current_secret_version, e.static_headers,
                e.last_successful_delivery_at, e.created_at, e.updated_at,
                (SELECT COALESCE(array_agg(s.pattern ORDER BY s.pattern), ARRAY[]::text[])
                 FROM endpoint_subscriptions s WHERE s.endpoint_id = e.id) AS event_patterns
         FROM endpoints e
         JOIN projects p ON p.id = e.project_id
         WHERE e.id = $1 AND e.project_id = $2 AND p.owner_id = $3
         FOR UPDATE`,
        [endpointId, projectId, ownerId],
      );
      const row = endpoint.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return null;
      }
      if (row.status === "disabled") {
        throw conflict(
          "ENDPOINT_DISABLED",
          "Disabled endpoints cannot rotate signing secrets",
        );
      }

      const nextVersion = Number(row.current_secret_version) + 1;
      await client.query(
        `UPDATE endpoint_secrets
         SET retired_at = COALESCE(retired_at, now())
         WHERE endpoint_id = $1 AND retired_at IS NULL`,
        [endpointId],
      );
      await client.query(
        `INSERT INTO endpoint_secrets
           (endpoint_id, version, ciphertext, iv, auth_tag, encryption_key_version)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          endpointId,
          nextVersion,
          secret.ciphertext,
          secret.iv,
          secret.authTag,
          secret.encryptionKeyVersion ?? null,
        ],
      );
      await client.query<DatabaseRow>(
        `UPDATE endpoints
          SET current_secret_version = $2, updated_at = now()
          WHERE id = $1
          RETURNING id, project_id, name, url, status, current_secret_version,
                    static_headers, last_successful_delivery_at, created_at, updated_at`,
        [endpointId, nextVersion],
      );
      if (audit) {
        await recordAudit(client, {
          action: "endpoint.secret.rotated",
          audit,
          projectId,
          endpointId,
          provider: secret.encryptionKeyVersion ? "vault" : "legacy",
          ...(secret.encryptionKeyVersion === undefined
            ? {}
            : { encryptionKeyVersion: secret.encryptionKeyVersion }),
          metadata: { secretVersion: nextVersion },
        });
      }
      await client.query("COMMIT");
      return this.getEndpoint(ownerId, projectId, endpointId);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async listEndpointSubscriptions(
    ownerId: string,
    projectId: string,
    endpointId: string,
  ): Promise<string[] | null> {
    const result = await this.pool.query<DatabaseRow>(
      `SELECT s.pattern
       FROM endpoint_subscriptions s
       JOIN endpoints e ON e.id = s.endpoint_id
       JOIN projects p ON p.id = e.project_id
       WHERE s.endpoint_id = $1 AND e.project_id = $2 AND p.owner_id = $3
       ORDER BY s.pattern`,
      [endpointId, projectId, ownerId],
    );
    if (
      result.rows.length === 0 &&
      !(await this.getEndpoint(ownerId, projectId, endpointId))
    ) {
      return null;
    }
    return result.rows.map((row) => String(row.pattern));
  }

  public async replaceEndpointSubscriptions(
    ownerId: string,
    projectId: string,
    endpointId: string,
    patterns: string[],
  ): Promise<string[] | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const endpoint = await client.query<DatabaseRow>(
        `SELECT e.id FROM endpoints e
         JOIN projects p ON p.id = e.project_id
         WHERE e.id = $1 AND e.project_id = $2 AND p.owner_id = $3
         FOR UPDATE`,
        [endpointId, projectId, ownerId],
      );
      if (!endpoint.rows[0]) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query(
        "DELETE FROM endpoint_subscriptions WHERE endpoint_id = $1",
        [endpointId],
      );
      for (const pattern of patterns) {
        await client.query(
          `INSERT INTO endpoint_subscriptions (endpoint_id, pattern)
           VALUES ($1, $2)`,
          [endpointId, pattern],
        );
      }
      await client.query("COMMIT");
      return [...patterns];
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async listDeliveries(
    ownerId: string,
    projectId: string,
    filter: DeliveryListFilter,
  ): Promise<DeliveryListResult> {
    const values: unknown[] = [projectId, ownerId];
    const conditions = ["p.id = $1", "p.owner_id = $2"];
    const addValue = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };

    if (filter.status) {
      conditions.push(`d.status = ${addValue(filter.status)}`);
    }
    if (filter.deliveryKind) {
      conditions.push(`d.delivery_kind = ${addValue(filter.deliveryKind)}`);
    } else {
      conditions.push("d.delivery_kind = 'event'");
    }
    if (filter.endpointId) {
      conditions.push(`d.endpoint_id = ${addValue(filter.endpointId)}::uuid`);
    }
    if (filter.eventType) {
      conditions.push(`e.event_type = ${addValue(filter.eventType)}`);
    }
    if (filter.from) {
      conditions.push(`d.created_at >= ${addValue(filter.from)}::timestamptz`);
    }
    if (filter.to) {
      conditions.push(`d.created_at < ${addValue(filter.to)}::timestamptz`);
    }
    if (filter.cursor) {
      const cursorCreatedAt = addValue(filter.cursor.createdAt);
      const cursorId = addValue(filter.cursor.id);
      conditions.push(
        `(d.created_at, d.id) < (${cursorCreatedAt}::timestamptz, ${cursorId}::uuid)`,
      );
    }
    const limit = filter.limit + 1;
    const limitParameter = addValue(limit);
    const result = await this.pool.query<DatabaseRow>(
      `SELECT ${deliveryColumns}
       FROM deliveries d
       JOIN events e ON e.id = d.event_id
       JOIN projects p ON p.id = e.project_id
       JOIN endpoints ep ON ep.id = d.endpoint_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY d.created_at DESC, d.id DESC
       LIMIT ${limitParameter}`,
      values,
    );
    const hasMore = result.rows.length > filter.limit;
    const rows = hasMore ? result.rows.slice(0, filter.limit) : result.rows;
    const last = rows.at(-1);
    return {
      deliveries: rows.map(mapDelivery),
      nextCursor:
        hasMore && last
          ? {
              createdAt: new Date(
                String(last.delivery_created_at),
              ).toISOString(),
              id: String(last.delivery_id),
            }
          : null,
    };
  }

  public async getDelivery(
    ownerId: string,
    projectId: string,
    deliveryId: string,
  ): Promise<DeliveryDetail | null> {
    const result = await this.pool.query<DatabaseRow>(
      `SELECT ${deliveryColumns}, e.payload AS event_payload
       FROM deliveries d
       JOIN events e ON e.id = d.event_id
       JOIN projects p ON p.id = e.project_id
       JOIN endpoints ep ON ep.id = d.endpoint_id
       WHERE d.id = $1 AND p.id = $2 AND p.owner_id = $3`,
      [deliveryId, projectId, ownerId],
    );
    const row = result.rows[0];
    if (!row) return null;

    const attempts = await this.pool.query<DatabaseRow>(
      `SELECT id, attempt_number, request_at, response_at, http_status_code,
              response_duration_ms, response_excerpt, error_classification, outcome
       FROM delivery_attempts
       WHERE delivery_id = $1
       ORDER BY attempt_number ASC`,
      [deliveryId],
    );
    return {
      delivery: mapDelivery(row),
      eventPayload: row.event_payload as JsonValue,
      attempts: attempts.rows.map(mapAttempt),
    };
  }

  public async replayDelivery(
    ownerId: string,
    projectId: string,
    deliveryId: string,
  ): Promise<DeliverySummary | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const source = await client.query<DatabaseRow>(
        `SELECT d.id, d.event_id, d.endpoint_id, d.status,
                e.project_id, ep.status AS endpoint_status, ep.url AS current_url,
                ep.current_secret_version, ep.static_headers
         FROM deliveries d
         JOIN events e ON e.id = d.event_id
         JOIN projects p ON p.id = e.project_id
         JOIN endpoints ep ON ep.id = d.endpoint_id
         WHERE d.id = $1 AND p.id = $2 AND p.owner_id = $3
         FOR UPDATE OF d, ep`,
        [deliveryId, projectId, ownerId],
      );
      const sourceRow = source.rows[0];
      if (!sourceRow) {
        await client.query("ROLLBACK");
        return null;
      }
      if (sourceRow.status !== "failed") {
        throw conflict(
          "DELIVERY_NOT_FAILED",
          "Only terminally failed deliveries can be replayed",
        );
      }
      if (sourceRow.endpoint_status !== "active") {
        throw conflict(
          "ENDPOINT_NOT_ACTIVE",
          "The endpoint must be active before a delivery can be replayed",
        );
      }

      await client.query(
        `SELECT id FROM deliveries
         WHERE event_id = $1 AND endpoint_id = $2
         FOR UPDATE`,
        [sourceRow.event_id, sourceRow.endpoint_id],
      );
      const nextReplay = await client.query<{ next: number }>(
        `SELECT COALESCE(MAX(replay_number), 0) + 1 AS next
         FROM deliveries WHERE event_id = $1 AND endpoint_id = $2`,
        [sourceRow.event_id, sourceRow.endpoint_id],
      );
      const replayNumber = Number(nextReplay.rows[0]?.next ?? 1);
      const inserted = await client.query<DatabaseRow>(
        `INSERT INTO deliveries
           (event_id, endpoint_id, endpoint_url, endpoint_secret_version,
            endpoint_static_headers, replay_of_delivery_id, replay_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          sourceRow.event_id,
          sourceRow.endpoint_id,
          sourceRow.current_url,
          sourceRow.current_secret_version,
          sourceRow.static_headers,
          sourceRow.id,
          replayNumber,
        ],
      );
      const replay = await client.query<DatabaseRow>(
        `SELECT ${deliveryColumns}
         FROM deliveries d
         JOIN events e ON e.id = d.event_id
         JOIN projects p ON p.id = e.project_id
         JOIN endpoints ep ON ep.id = d.endpoint_id
         WHERE d.id = $1`,
        [inserted.rows[0]!.id],
      );
      await client.query("COMMIT");
      return mapDelivery(replay.rows[0]!);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async bulkReplayDeliveries(input: {
    ownerId: string;
    projectId: string;
    deliveryIds: string[];
    idempotencyKey: string;
    requestHash: string;
  }): Promise<BulkDeliveryResult | null> {
    return this.runBulkOperation(input, "replay", async (client) => {
      const sources = await client.query<DatabaseRow>(
        `SELECT d.id, d.event_id, d.endpoint_id, d.status,
                ep.status AS endpoint_status, ep.url AS current_url,
                ep.current_secret_version, ep.static_headers
         FROM deliveries d
         JOIN events e ON e.id = d.event_id
         JOIN projects p ON p.id = e.project_id
         JOIN endpoints ep ON ep.id = d.endpoint_id
         WHERE d.id = ANY($1::uuid[]) AND p.id = $2 AND p.owner_id = $3
         FOR UPDATE OF d, ep`,
        [input.deliveryIds, input.projectId, input.ownerId],
      );
      const byId = new Map(sources.rows.map((row) => [String(row.id), row]));
      const skipped: Array<{ deliveryId: string; reason: string }> = [];
      const deliveries: DeliverySummary[] = [];

      for (const deliveryId of input.deliveryIds) {
        const source = byId.get(deliveryId);
        if (!source) {
          skipped.push({ deliveryId, reason: "DELIVERY_NOT_FOUND" });
          continue;
        }
        if (source.status !== "failed") {
          skipped.push({ deliveryId, reason: "DELIVERY_NOT_FAILED" });
          continue;
        }
        if (source.endpoint_status !== "active") {
          skipped.push({ deliveryId, reason: "ENDPOINT_NOT_ACTIVE" });
          continue;
        }

        await client.query(
          `SELECT id FROM deliveries
           WHERE event_id = $1 AND endpoint_id = $2 FOR UPDATE`,
          [source.event_id, source.endpoint_id],
        );
        const nextReplay = await client.query<{ next: number }>(
          `SELECT COALESCE(MAX(replay_number), 0) + 1 AS next
           FROM deliveries WHERE event_id = $1 AND endpoint_id = $2`,
          [source.event_id, source.endpoint_id],
        );
        const replayNumber = Number(nextReplay.rows[0]?.next ?? 1);
        const inserted = await client.query<DatabaseRow>(
          `INSERT INTO deliveries
             (event_id, endpoint_id, endpoint_url, endpoint_secret_version,
              endpoint_static_headers, replay_of_delivery_id, replay_number)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [
            source.event_id,
            source.endpoint_id,
            source.current_url,
            source.current_secret_version,
            source.static_headers,
            source.id,
            replayNumber,
          ],
        );
        const replay = await client.query<DatabaseRow>(
          `SELECT ${deliveryColumns}
           FROM deliveries d
           JOIN events e ON e.id = d.event_id
           JOIN projects p ON p.id = e.project_id
           JOIN endpoints ep ON ep.id = d.endpoint_id
           WHERE d.id = $1`,
          [inserted.rows[0]!.id],
        );
        deliveries.push(mapDelivery(replay.rows[0]!));
      }

      return { deliveries, skipped };
    });
  }

  public async bulkCancelDeliveries(input: {
    ownerId: string;
    projectId: string;
    deliveryIds: string[];
    idempotencyKey: string;
    requestHash: string;
    reason: string;
  }): Promise<BulkDeliveryResult | null> {
    return this.runBulkOperation(input, "cancel", async (client) => {
      const sources = await client.query<DatabaseRow>(
        `SELECT d.id, d.status
         FROM deliveries d
         JOIN events e ON e.id = d.event_id
         JOIN projects p ON p.id = e.project_id
         WHERE d.id = ANY($1::uuid[]) AND p.id = $2 AND p.owner_id = $3
         FOR UPDATE OF d`,
        [input.deliveryIds, input.projectId, input.ownerId],
      );
      const byId = new Map(sources.rows.map((row) => [String(row.id), row]));
      const skipped: Array<{ deliveryId: string; reason: string }> = [];
      const deliveries: DeliverySummary[] = [];
      for (const deliveryId of input.deliveryIds) {
        const source = byId.get(deliveryId);
        if (!source) {
          skipped.push({ deliveryId, reason: "DELIVERY_NOT_FOUND" });
          continue;
        }
        if (source.status === "pending") {
          await client.query(
            `UPDATE deliveries
             SET status = 'cancelled', cancelled_at = now(),
                 cancellation_reason = $2, completed_at = now(),
                 updated_at = now()
             WHERE id = $1`,
            [deliveryId, input.reason],
          );
        } else if (source.status === "in_flight") {
          await client.query(
            `UPDATE deliveries
             SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
                 cancellation_reason = $2, updated_at = now()
             WHERE id = $1`,
            [deliveryId, input.reason],
          );
        } else {
          skipped.push({
            deliveryId,
            reason: `DELIVERY_${String(source.status).toUpperCase()}`,
          });
          continue;
        }
        const updated = await client.query<DatabaseRow>(
          `SELECT ${deliveryColumns}
           FROM deliveries d
           JOIN events e ON e.id = d.event_id
           JOIN projects p ON p.id = e.project_id
           JOIN endpoints ep ON ep.id = d.endpoint_id
           WHERE d.id = $1`,
          [deliveryId],
        );
        deliveries.push(mapDelivery(updated.rows[0]!));
      }
      return { deliveries, skipped };
    });
  }

  private async runBulkOperation(
    input: {
      ownerId: string;
      projectId: string;
      deliveryIds: string[];
      idempotencyKey: string;
      requestHash: string;
      reason?: string;
    },
    operation: "replay" | "cancel",
    run: (client: PoolClient) => Promise<{
      deliveries: DeliverySummary[];
      skipped: Array<{ deliveryId: string; reason: string }>;
    }>,
  ): Promise<BulkDeliveryResult | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const project = await client.query<DatabaseRow>(
        "SELECT id FROM projects WHERE id = $1 AND owner_id = $2 FOR UPDATE",
        [input.projectId, input.ownerId],
      );
      if (!project.rows[0]) {
        await client.query("ROLLBACK");
        return null;
      }
      const existing = await client.query<DatabaseRow>(
        `SELECT id, operation, request_hash, response
         FROM delivery_bulk_operations
         WHERE project_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [input.projectId, input.idempotencyKey],
      );
      const existingRow = existing.rows[0];
      if (existingRow) {
        if (
          String(existingRow.request_hash) !== input.requestHash ||
          String(existingRow.operation) !== operation
        ) {
          throw conflict(
            "IDEMPOTENCY_KEY_REUSED",
            "Idempotency-Key was already used for another bulk operation",
          );
        }
        await client.query("COMMIT");
        return existingRow.response as BulkDeliveryResult;
      }

      const result = await run(client);
      const operationId = randomUUID();
      const response: BulkDeliveryResult = {
        operationId,
        requested: input.deliveryIds.length,
        processed: result.deliveries.length,
        deliveries: result.deliveries,
        skipped: result.skipped,
      };
      await client.query(
        `INSERT INTO delivery_bulk_operations
           (id, project_id, idempotency_key, operation, request_hash, response)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          operationId,
          input.projectId,
          input.idempotencyKey,
          operation,
          input.requestHash,
          response,
        ],
      );
      await client.query("COMMIT");
      return response;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async getDeadLetterAlert(
    ownerId: string,
    projectId: string,
  ): Promise<AlertDestination | null> {
    const result = await this.pool.query<DatabaseRow>(
      `SELECT a.endpoint_id, ep.name, ep.url, a.updated_at
       FROM project_dead_letter_alerts a
       JOIN projects p ON p.id = a.project_id
       JOIN endpoints ep ON ep.id = a.endpoint_id
       WHERE a.project_id = $1 AND p.owner_id = $2`,
      [projectId, ownerId],
    );
    const row = result.rows[0];
    return row
      ? {
          endpointId: String(row.endpoint_id),
          endpointName: String(row.name),
          endpointUrl: String(row.url),
          updatedAt: new Date(String(row.updated_at)).toISOString(),
        }
      : null;
  }

  public async setDeadLetterAlert(input: {
    ownerId: string;
    projectId: string;
    endpointId: string;
  }): Promise<AlertDestination | null> {
    const endpoint = await this.pool.query<DatabaseRow>(
      `SELECT ep.id, ep.name, ep.url
       FROM endpoints ep JOIN projects p ON p.id = ep.project_id
       WHERE ep.id = $1 AND ep.project_id = $2 AND p.owner_id = $3
         AND ep.status <> 'disabled'`,
      [input.endpointId, input.projectId, input.ownerId],
    );
    if (!endpoint.rows[0]) return null;
    await this.pool.query(
      `INSERT INTO project_dead_letter_alerts (project_id, endpoint_id)
       VALUES ($1, $2)
       ON CONFLICT (project_id) DO UPDATE SET endpoint_id = EXCLUDED.endpoint_id, updated_at = now()`,
      [input.projectId, input.endpointId],
    );
    return this.getDeadLetterAlert(input.ownerId, input.projectId);
  }

  public async clearDeadLetterAlert(
    ownerId: string,
    projectId: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM project_dead_letter_alerts a USING projects p
       WHERE a.project_id = $1 AND p.id = a.project_id AND p.owner_id = $2`,
      [projectId, ownerId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  public async reconcileExpiredDeliveries(
    ownerId: string,
    projectId: string,
  ): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const project = await client.query(
        `SELECT id FROM projects WHERE id = $1 AND owner_id = $2`,
        [projectId, ownerId],
      );
      if (project.rowCount === 0) {
        await client.query("COMMIT");
        return 0;
      }
      await client.query(
        `INSERT INTO delivery_project_quota_locks (project_id)
         VALUES ($1) ON CONFLICT DO NOTHING`,
        [projectId],
      );
      await client.query(
        `SELECT project_id
           FROM delivery_project_quota_locks
          WHERE project_id = $1
          FOR UPDATE`,
        [projectId],
      );
      const result = await client.query(
        `UPDATE deliveries d
          SET status = CASE WHEN d.cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE 'pending' END,
              next_attempt_at = LEAST(d.next_attempt_at, now()),
              lease_expires_at = NULL,
              lease_token = NULL,
              cancelled_at = CASE WHEN d.cancel_requested_at IS NOT NULL THEN COALESCE(d.cancelled_at, now()) ELSE d.cancelled_at END,
              completed_at = CASE WHEN d.cancel_requested_at IS NOT NULL THEN COALESCE(d.completed_at, now()) ELSE d.completed_at END,
              updated_at = now()
         FROM events e
         WHERE d.event_id = e.id
           AND e.project_id = $1
           AND d.status = 'in_flight'
           AND d.lease_expires_at <= now()
         RETURNING d.id`,
        [projectId],
      );
      await client.query("COMMIT");
      return result.rowCount ?? 0;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

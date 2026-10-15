import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { z } from "zod";

const configSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1)
    .default(
      "postgresql://hookforge:hookforge_dev_only@localhost:5432/hookforge",
    ),
  ARCHIVE_AFTER_MONTHS: z.coerce.number().int().min(0).max(120).default(3),
  PURGE_AFTER_MONTHS: z.coerce.number().int().min(1).max(240).default(24),
  PARTITION_LOOKAHEAD_MONTHS: z.coerce.number().int().min(0).max(24).default(2),
  RETENTION_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(100),
  RETENTION_DRY_RUN: z.enum(["true", "false"]).default("false"),
});

type RetentionConfig = z.infer<typeof configSchema> & {
  RETENTION_DRY_RUN: boolean;
};
type Row = QueryResultRow & Record<string, unknown>;

const archiveTables = ["events", "deliveries", "delivery_attempts"] as const;

function parseConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RetentionConfig {
  const result = configSchema.safeParse(environment);
  if (!result.success) {
    throw new Error(`Invalid retention configuration: ${result.error.message}`);
  }
  return {
    ...result.data,
    RETENTION_DRY_RUN: result.data.RETENTION_DRY_RUN === "true",
  };
}

function monthStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

function addMonths(value: Date, amount: number): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + amount, 1),
  );
}

function monthLabel(value: Date): string {
  return `${value.getUTCFullYear()}_${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
}

function sqlMonth(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function partitionName(
  table: (typeof archiveTables)[number],
  month: Date,
): string {
  return `${table}_${monthLabel(month)}`;
}

async function ensurePartition(
  client: PoolClient,
  table: (typeof archiveTables)[number],
  month: Date,
): Promise<void> {
  const nextMonth = addMonths(month, 1);
  const name = partitionName(table, month);
  await client.query(
    `CREATE TABLE IF NOT EXISTS hookforge_archive.${name}
       PARTITION OF hookforge_archive.${table}
       FOR VALUES FROM ('${sqlMonth(month)}') TO ('${sqlMonth(nextMonth)}')`,
  );
}

async function ensurePartitionsForRange(
  client: PoolClient,
  table: (typeof archiveTables)[number],
  first: Date,
  last: Date,
): Promise<void> {
  for (
    let month = monthStart(first);
    month <= monthStart(last);
    month = addMonths(month, 1)
  ) {
    await ensurePartition(client, table, month);
  }
}

async function ensurePartitionsForRows(
  client: PoolClient,
  events: Row[],
  deliveries: Row[],
  attempts: Row[],
): Promise<void> {
  const eventDates = events.map((row) => new Date(String(row.created_at)));
  const deliveryDates = deliveries.map(
    (row) => new Date(String(row.created_at)),
  );
  const attemptDates = attempts.map((row) => new Date(String(row.request_at)));
  if (eventDates.length > 0) {
    await ensurePartitionsForRange(
      client,
      "events",
      new Date(Math.min(...eventDates.map((date) => date.getTime()))),
      new Date(Math.max(...eventDates.map((date) => date.getTime()))),
    );
  }
  if (deliveryDates.length > 0) {
    await ensurePartitionsForRange(
      client,
      "deliveries",
      new Date(Math.min(...deliveryDates.map((date) => date.getTime()))),
      new Date(Math.max(...deliveryDates.map((date) => date.getTime()))),
    );
  }
  if (attemptDates.length > 0) {
    await ensurePartitionsForRange(
      client,
      "delivery_attempts",
      new Date(Math.min(...attemptDates.map((date) => date.getTime()))),
      new Date(Math.max(...attemptDates.map((date) => date.getTime()))),
    );
  }
}

async function archiveEvent(
  client: PoolClient,
  rootEventId: string,
  dryRun: boolean,
): Promise<{ events: number; deliveries: number; attempts: number }> {
  const eventResult = await client.query<Row>(
    `SELECT e.*
       FROM events e
      WHERE e.id = $1
         OR e.id IN (
           SELECT alert.event_id
             FROM deliveries source
             JOIN deliveries alert
               ON alert.alert_source_delivery_id = source.id
            WHERE source.event_id = $1
         )
      FOR UPDATE`,
    [rootEventId],
  );
  const eventIds = eventResult.rows.map((row) => String(row.id));
  if (eventIds.length === 0) {
    return { events: 0, deliveries: 0, attempts: 0 };
  }
  const liveWork = await client.query(
    `SELECT 1
       FROM deliveries
      WHERE event_id = ANY($1::uuid[])
        AND status IN ('pending', 'in_flight')
      LIMIT 1`,
    [eventIds],
  );
  if (liveWork.rowCount) {
    throw new Error("event graph became active during retention");
  }

  const deliveryResult = await client.query<Row>(
    `SELECT d.* FROM deliveries d WHERE d.event_id = ANY($1::uuid[])`,
    [eventIds],
  );
  const deliveryIds = deliveryResult.rows.map((row) => String(row.id));
  const attemptResult = deliveryIds.length
    ? await client.query<Row>(
        `SELECT a.*
           FROM delivery_attempts a
          WHERE a.delivery_id = ANY($1::uuid[])`,
        [deliveryIds],
      )
    : { rows: [] as Row[] };

  await ensurePartitionsForRows(
    client,
    eventResult.rows,
    deliveryResult.rows,
    attemptResult.rows,
  );
  if (dryRun) {
    return {
      events: eventResult.rows.length,
      deliveries: deliveryResult.rows.length,
      attempts: attemptResult.rows.length,
    };
  }

  await client.query(
    `INSERT INTO hookforge_archive.delivery_attempts
       (id, delivery_id, attempt_number, request_at, response_at,
        http_status_code, response_duration_ms, response_excerpt,
        error_classification, outcome, created_at)
     SELECT id, delivery_id, attempt_number, request_at, response_at,
            http_status_code, response_duration_ms, response_excerpt,
            error_classification, outcome, request_at
       FROM delivery_attempts
      WHERE delivery_id = ANY($1::uuid[])
     ON CONFLICT DO NOTHING`,
    [deliveryIds],
  );
  await client.query(
    `INSERT INTO hookforge_archive.deliveries
       (id, event_id, endpoint_id, endpoint_url, endpoint_secret_version,
        status, attempt_count, next_attempt_at, lease_expires_at,
        last_http_status_code, last_error, created_at, updated_at,
        completed_at, lease_token, replay_of_delivery_id, replay_number,
        endpoint_static_headers, cancel_requested_at, cancelled_at,
        cancellation_reason, dead_lettered_at, dead_letter_reason,
        delivery_kind, alert_source_delivery_id)
     SELECT id, event_id, endpoint_id, endpoint_url, endpoint_secret_version,
            status, attempt_count, next_attempt_at, lease_expires_at,
            last_http_status_code, last_error, created_at, updated_at,
            completed_at, lease_token, replay_of_delivery_id, replay_number,
            endpoint_static_headers, cancel_requested_at, cancelled_at,
            cancellation_reason, dead_lettered_at, dead_letter_reason,
            delivery_kind, alert_source_delivery_id
       FROM deliveries
      WHERE event_id = ANY($1::uuid[])
     ON CONFLICT DO NOTHING`,
    [eventIds],
  );
  await client.query(
    `INSERT INTO hookforge_archive.events
       (id, project_id, event_type, payload, created_at, is_internal)
     SELECT id, project_id, event_type, payload, created_at, is_internal
       FROM events
      WHERE id = ANY($1::uuid[])
     ON CONFLICT DO NOTHING`,
    [eventIds],
  );
  await client.query(
    `INSERT INTO hookforge_archive.event_idempotency_keys
       (project_id, idempotency_key, request_hash, event_id, created_at)
     SELECT project_id, idempotency_key, request_hash, event_id, created_at
       FROM event_idempotency_keys
      WHERE event_id = ANY($1::uuid[])
     ON CONFLICT DO NOTHING`,
    [eventIds],
  );

  if (deliveryIds.length > 0) {
    await client.query(
      `DELETE FROM delivery_attempts WHERE delivery_id = ANY($1::uuid[])`,
      [deliveryIds],
    );
    // Break self/referential delivery links before deleting the complete
    // graph. The values have already been copied to the archive.
    await client.query(
      `UPDATE deliveries
          SET replay_of_delivery_id = NULL,
              alert_source_delivery_id = NULL
        WHERE id = ANY($1::uuid[])`,
      [deliveryIds],
    );
    await client.query(`DELETE FROM deliveries WHERE id = ANY($1::uuid[])`, [
      deliveryIds,
    ]);
  }
  await client.query(
    `DELETE FROM event_idempotency_keys WHERE event_id = ANY($1::uuid[])`,
    [eventIds],
  );
  await client.query(`DELETE FROM events WHERE id = ANY($1::uuid[])`, [
    eventIds,
  ]);

  return {
    events: eventResult.rows.length,
    deliveries: deliveryResult.rows.length,
    attempts: attemptResult.rows.length,
  };
}

async function archiveEligibleEvents(
  pool: Pool,
  config: RetentionConfig,
  cutoff: Date,
): Promise<void> {
  const candidates = await pool.query<{ id: string }>(
    `SELECT e.id
       FROM events e
      WHERE e.created_at < $1
        AND NOT EXISTS (
          SELECT 1 FROM deliveries d
           WHERE d.event_id = e.id AND d.status IN ('pending', 'in_flight')
        )
        AND NOT EXISTS (
          SELECT 1
            FROM deliveries source
            JOIN deliveries alert
              ON alert.alert_source_delivery_id = source.id
           WHERE source.event_id = e.id
             AND alert.status IN ('pending', 'in_flight')
        )
      ORDER BY e.created_at, e.id
      LIMIT $2`,
    [cutoff, config.RETENTION_BATCH_SIZE],
  );

  let failures = 0;
  for (const candidate of candidates.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO retention_partition_runs (month_start, archive_started_at, updated_at)
         VALUES (date_trunc('month', $1::timestamptz)::date, now(), now())
         ON CONFLICT (month_start) DO UPDATE SET archive_started_at = now(), error = NULL, updated_at = now()`,
        [cutoff],
      );
      const counts = await archiveEvent(
        client,
        candidate.id,
        config.RETENTION_DRY_RUN,
      );
      if (!config.RETENTION_DRY_RUN) {
        await client.query(
          `UPDATE retention_partition_runs
              SET archive_completed_at = now(),
                  events_archived = events_archived + $2,
                  deliveries_archived = deliveries_archived + $3,
                  attempts_archived = attempts_archived + $4,
                  updated_at = now()
            WHERE month_start = date_trunc('month', $1::timestamptz)::date`,
          [cutoff, counts.events, counts.deliveries, counts.attempts],
        );
      }
      await client.query("COMMIT");
      console.info(
        JSON.stringify({
          message: "retention_archive_completed",
          eventId: candidate.id,
          ...counts,
          dryRun: config.RETENTION_DRY_RUN,
        }),
      );
    } catch (error) {
      failures += 1;
      await client.query("ROLLBACK").catch(() => undefined);
      console.error(
        JSON.stringify({
          message: "retention_archive_failed",
          eventId: candidate.id,
          error: error instanceof Error ? error.message : "unknown_error",
        }),
      );
    } finally {
      client.release();
    }
  }
  if (failures > 0) {
    throw new Error(`${failures} retention archive batch(es) failed`);
  }
}

async function createLookaheadPartitions(
  pool: Pool,
  config: RetentionConfig,
  now: Date,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = monthStart(now);
    const first = addMonths(current, -config.ARCHIVE_AFTER_MONTHS);
    const last = addMonths(current, config.PARTITION_LOOKAHEAD_MONTHS);
    for (const table of archiveTables) {
      await ensurePartitionsForRange(client, table, first, last);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function purgeOldPartitions(
  pool: Pool,
  cutoff: Date,
  dryRun: boolean,
): Promise<void> {
  const result = await pool.query<{ table_name: string }>(
    `SELECT c.relname AS table_name
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class parent ON parent.oid = i.inhparent
       JOIN pg_namespace n ON n.oid = parent.relnamespace
      WHERE n.nspname = 'hookforge_archive'
        AND parent.relname = ANY($1::text[])
        AND c.relname ~ '^(events|deliveries|delivery_attempts)_[0-9]{4}_[0-9]{2}$'`,
    [archiveTables],
  );
  for (const row of result.rows) {
    const match = /_(\d{4})_(\d{2})$/.exec(row.table_name);
    if (!match) continue;
    const partitionMonth = new Date(
      Date.UTC(Number(match[1]), Number(match[2]) - 1, 1),
    );
    if (partitionMonth >= cutoff) continue;
    if (dryRun) {
      console.info(
        JSON.stringify({
          message: "retention_partition_would_drop",
          table: row.table_name,
        }),
      );
    } else {
      await pool.query(
        `DROP TABLE IF EXISTS hookforge_archive.${row.table_name}`,
      );
      console.info(
        JSON.stringify({
          message: "retention_partition_dropped",
          table: row.table_name,
        }),
      );
    }
  }
}

const config = parseConfig();
const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 2,
  connectionTimeoutMillis: 2_000,
});

const coordinator = await pool.connect();
let locked = false;
try {
  await coordinator.query("SET lock_timeout = '5s'");
  await coordinator.query("SET statement_timeout = '5min'");
  const lock = await coordinator.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock(hashtextextended('hookforge:retention', 0)) AS locked",
  );
  locked = Boolean(lock.rows[0]?.locked);
  if (!locked) {
    console.info(JSON.stringify({ message: "retention_already_running" }));
  } else {
    const now = new Date();
    await createLookaheadPartitions(pool, config, now);
    const archiveCutoff = addMonths(
      monthStart(now),
      -config.ARCHIVE_AFTER_MONTHS,
    );
    const purgeCutoff = addMonths(monthStart(now), -config.PURGE_AFTER_MONTHS);
    await archiveEligibleEvents(pool, config, archiveCutoff);
    await purgeOldPartitions(pool, purgeCutoff, config.RETENTION_DRY_RUN);
  }
} finally {
  if (locked) {
    await coordinator.query(
      "SELECT pg_advisory_unlock(hashtextextended('hookforge:retention', 0))",
    );
  }
  coordinator.release();
  await pool.end();
}

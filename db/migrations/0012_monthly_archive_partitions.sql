-- Historical data is kept outside the hot queue tables.  The archive tables
-- are declaratively partitioned so retention can remove a whole month with a
-- metadata-only DROP instead of scanning the live queue.
CREATE SCHEMA IF NOT EXISTS hookforge_archive;

CREATE TABLE hookforge_archive.events (
  LIKE public.events INCLUDING DEFAULTS
) PARTITION BY RANGE (created_at);

ALTER TABLE hookforge_archive.events
  ADD CONSTRAINT archive_events_id_created_key UNIQUE (id, created_at);

CREATE TABLE hookforge_archive.deliveries (
  LIKE public.deliveries INCLUDING DEFAULTS
) PARTITION BY RANGE (created_at);

ALTER TABLE hookforge_archive.deliveries
  ADD CONSTRAINT archive_deliveries_id_created_key UNIQUE (id, created_at);

CREATE TABLE hookforge_archive.delivery_attempts (
  LIKE public.delivery_attempts INCLUDING DEFAULTS,
  created_at timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

ALTER TABLE hookforge_archive.delivery_attempts
  ADD CONSTRAINT archive_delivery_attempts_id_created_key UNIQUE (id, created_at);

CREATE TABLE hookforge_archive.event_idempotency_keys (
  LIKE public.event_idempotency_keys INCLUDING DEFAULTS
);

ALTER TABLE hookforge_archive.event_idempotency_keys
  ADD CONSTRAINT archive_event_idempotency_keys_pkey
    PRIMARY KEY (project_id, idempotency_key),
  ADD CONSTRAINT archive_event_idempotency_event_key UNIQUE (event_id);

CREATE INDEX archive_events_project_created_idx
  ON hookforge_archive.events (project_id, created_at DESC, id DESC);
CREATE INDEX archive_deliveries_event_idx
  ON hookforge_archive.deliveries (event_id, created_at DESC);
CREATE INDEX archive_delivery_attempts_delivery_idx
  ON hookforge_archive.delivery_attempts (delivery_id, created_at DESC);

CREATE TABLE IF NOT EXISTS retention_partition_runs (
  month_start date PRIMARY KEY,
  archive_started_at timestamptz,
  archive_completed_at timestamptz,
  purge_completed_at timestamptz,
  events_archived bigint NOT NULL DEFAULT 0,
  deliveries_archived bigint NOT NULL DEFAULT 0,
  attempts_archived bigint NOT NULL DEFAULT 0,
  error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE hookforge_archive.events IS
  'Monthly RANGE partitions populated by the retention runner; live events remain available for the configured hot retention window.';
COMMENT ON TABLE hookforge_archive.deliveries IS
  'Monthly RANGE partitions populated by the retention runner.';
COMMENT ON TABLE hookforge_archive.delivery_attempts IS
  'Monthly RANGE partitions populated by the retention runner; created_at mirrors request_at.';

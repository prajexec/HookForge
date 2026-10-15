ALTER TABLE deliveries
  DROP CONSTRAINT deliveries_status_check;

ALTER TABLE deliveries
  ADD CONSTRAINT deliveries_status_check CHECK (
    status IN ('pending', 'in_flight', 'delivered', 'failed', 'cancelled')
  ),
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancellation_reason text,
  ADD COLUMN dead_lettered_at timestamptz,
  ADD COLUMN dead_letter_reason text,
  ADD COLUMN delivery_kind text NOT NULL DEFAULT 'event',
  ADD COLUMN alert_source_delivery_id uuid REFERENCES deliveries(id) ON DELETE SET NULL,
  ADD CONSTRAINT deliveries_kind_check CHECK (delivery_kind IN ('event', 'dead_letter_alert'));

CREATE UNIQUE INDEX deliveries_alert_source_idx
  ON deliveries (alert_source_delivery_id)
  WHERE alert_source_delivery_id IS NOT NULL;

CREATE INDEX deliveries_dead_letter_idx
  ON deliveries (dead_lettered_at DESC, id)
  WHERE dead_lettered_at IS NOT NULL;

ALTER TABLE events
  ADD COLUMN is_internal boolean NOT NULL DEFAULT false;

UPDATE deliveries
SET dead_lettered_at = COALESCE(completed_at, updated_at, now()),
    dead_letter_reason = COALESCE(last_error, 'legacy_failed')
WHERE status = 'failed' AND dead_lettered_at IS NULL;

CREATE TABLE delivery_bulk_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  operation text NOT NULL,
  request_hash char(64) NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_bulk_operation_kind_check CHECK (operation IN ('replay', 'cancel')),
  CONSTRAINT delivery_bulk_operation_key_length CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  CONSTRAINT delivery_bulk_operation_unique_key UNIQUE (project_id, idempotency_key)
);

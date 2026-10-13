ALTER TABLE deliveries
  ADD COLUMN lease_token uuid;

CREATE INDEX deliveries_expired_lease_idx
  ON deliveries (lease_expires_at, id)
  WHERE status = 'in_flight';

CREATE TABLE delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  request_at timestamptz NOT NULL,
  response_at timestamptz,
  http_status_code integer,
  response_duration_ms integer,
  response_excerpt text,
  error_classification text,
  outcome text NOT NULL,
  CONSTRAINT delivery_attempts_unique_number UNIQUE (delivery_id, attempt_number),
  CONSTRAINT delivery_attempts_number_check CHECK (attempt_number > 0),
  CONSTRAINT delivery_attempts_http_status_check CHECK (
    http_status_code IS NULL OR http_status_code BETWEEN 100 AND 599
  ),
  CONSTRAINT delivery_attempts_duration_check CHECK (
    response_duration_ms IS NULL OR response_duration_ms >= 0
  ),
  CONSTRAINT delivery_attempts_outcome_check CHECK (outcome IN ('success', 'retry', 'failed'))
);

CREATE INDEX delivery_attempts_delivery_idx
  ON delivery_attempts (delivery_id, attempt_number DESC);

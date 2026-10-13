CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT events_type_length CHECK (char_length(event_type) BETWEEN 1 AND 100)
);

CREATE INDEX events_project_created_idx
  ON events (project_id, created_at DESC, id DESC);

CREATE TABLE event_idempotency_keys (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_hash char(64) NOT NULL,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, idempotency_key),
  CONSTRAINT event_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 1 AND 255)
);

CREATE UNIQUE INDEX event_idempotency_event_idx
  ON event_idempotency_keys (event_id);

CREATE TABLE deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  endpoint_id uuid NOT NULL REFERENCES endpoints(id) ON DELETE RESTRICT,
  endpoint_url text NOT NULL,
  endpoint_secret_version integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  last_http_status_code integer,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT deliveries_unique_event_endpoint UNIQUE (event_id, endpoint_id),
  CONSTRAINT deliveries_status_check CHECK (status IN ('pending', 'in_flight', 'delivered', 'failed')),
  CONSTRAINT deliveries_attempt_count_check CHECK (attempt_count >= 0),
  CONSTRAINT deliveries_secret_version_check CHECK (endpoint_secret_version > 0),
  CONSTRAINT deliveries_http_status_check CHECK (
    last_http_status_code IS NULL OR last_http_status_code BETWEEN 100 AND 599
  )
);

CREATE INDEX deliveries_due_idx
  ON deliveries (next_attempt_at, id)
  WHERE status = 'pending';
CREATE INDEX deliveries_event_idx
  ON deliveries (event_id);
CREATE INDEX deliveries_endpoint_status_idx
  ON deliveries (endpoint_id, status);

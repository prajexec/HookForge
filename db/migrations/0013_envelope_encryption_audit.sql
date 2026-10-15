CREATE TABLE encryption_key_versions (
  version integer PRIMARY KEY,
  provider text NOT NULL,
  provider_key_id text NOT NULL,
  wrapped_data_key text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CONSTRAINT encryption_key_provider_check CHECK (provider IN ('vault')),
  CONSTRAINT encryption_key_status_check CHECK (status IN ('active', 'retiring', 'retired'))
);

CREATE UNIQUE INDEX encryption_key_versions_active_idx
  ON encryption_key_versions (status)
  WHERE status = 'active';

ALTER TABLE endpoint_secrets
  ADD COLUMN encryption_key_version integer
    REFERENCES encryption_key_versions(version) ON DELETE RESTRICT;

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  action text NOT NULL,
  actor_type text NOT NULL,
  actor_id uuid,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  endpoint_id uuid REFERENCES endpoints(id) ON DELETE SET NULL,
  request_id text,
  trace_id text,
  provider text,
  provider_key_id text,
  encryption_key_version integer,
  success boolean NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT audit_events_action_length CHECK (char_length(action) BETWEEN 1 AND 120),
  CONSTRAINT audit_events_actor_type_length CHECK (char_length(actor_type) BETWEEN 1 AND 40)
);

CREATE INDEX audit_events_occurred_idx
  ON audit_events (occurred_at DESC, id DESC);
CREATE INDEX audit_events_resource_idx
  ON audit_events (project_id, endpoint_id, occurred_at DESC);

CREATE TABLE project_dead_letter_alerts (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  endpoint_id uuid NOT NULL REFERENCES endpoints(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX project_dead_letter_alerts_endpoint_idx
  ON project_dead_letter_alerts (endpoint_id);

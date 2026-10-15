-- These rows are transaction mutexes for quota-aware delivery claims. The
-- delivery status remains the source of truth for current occupancy.
CREATE TABLE delivery_project_quota_locks (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE delivery_endpoint_quota_locks (
  endpoint_id uuid PRIMARY KEY REFERENCES endpoints(id) ON DELETE CASCADE
);

INSERT INTO delivery_project_quota_locks (project_id)
SELECT id FROM projects
ON CONFLICT DO NOTHING;

INSERT INTO delivery_endpoint_quota_locks (endpoint_id)
SELECT id FROM endpoints
ON CONFLICT DO NOTHING;

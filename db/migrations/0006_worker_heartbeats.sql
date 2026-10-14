CREATE TABLE worker_heartbeats (
  worker_id text PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT true,
  concurrency integer NOT NULL,
  active_jobs integer NOT NULL DEFAULT 0,
  CONSTRAINT worker_heartbeats_id_length CHECK (char_length(worker_id) BETWEEN 1 AND 128),
  CONSTRAINT worker_heartbeats_concurrency_check CHECK (concurrency > 0),
  CONSTRAINT worker_heartbeats_active_jobs_check CHECK (active_jobs >= 0)
);

CREATE INDEX worker_heartbeats_active_idx
  ON worker_heartbeats (heartbeat_at DESC)
  WHERE active = true;

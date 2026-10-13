CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  email_normalized text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_length CHECK (char_length(email_normalized) BETWEEN 3 AND 320)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_active_user_idx
  ON sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  name_normalized text NOT NULL,
  public_identifier text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT projects_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT projects_name_normalized_length CHECK (char_length(name_normalized) BETWEEN 1 AND 120)
);

CREATE UNIQUE INDEX projects_owner_name_idx
  ON projects (owner_id, name_normalized);
CREATE INDEX projects_owner_created_idx
  ON projects (owner_id, created_at DESC, id DESC);

CREATE TABLE endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  name_normalized text NOT NULL,
  url text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  current_secret_version integer NOT NULL DEFAULT 1,
  last_successful_delivery_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT endpoints_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT endpoints_url_length CHECK (char_length(url) BETWEEN 1 AND 2048),
  CONSTRAINT endpoints_status_check CHECK (status IN ('active', 'paused', 'disabled')),
  CONSTRAINT endpoints_secret_version_check CHECK (current_secret_version > 0)
);

CREATE UNIQUE INDEX endpoints_project_name_idx
  ON endpoints (project_id, name_normalized);
CREATE INDEX endpoints_project_created_idx
  ON endpoints (project_id, created_at DESC, id DESC);
CREATE INDEX endpoints_project_status_idx
  ON endpoints (project_id, status);

CREATE TABLE endpoint_secrets (
  endpoint_id uuid NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  version integer NOT NULL,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  PRIMARY KEY (endpoint_id, version),
  CONSTRAINT endpoint_secret_version_check CHECK (version > 0)
);

CREATE UNIQUE INDEX endpoint_secrets_current_idx
  ON endpoint_secrets (endpoint_id)
  WHERE retired_at IS NULL;

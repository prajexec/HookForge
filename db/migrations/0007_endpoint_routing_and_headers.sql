ALTER TABLE endpoints
  ADD COLUMN static_headers jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE deliveries
  ADD COLUMN endpoint_static_headers jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE endpoint_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id uuid NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  pattern text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT endpoint_subscriptions_pattern_length CHECK (char_length(pattern) BETWEEN 1 AND 100),
  CONSTRAINT endpoint_subscriptions_pattern_format CHECK (
    pattern = '*' OR pattern !~ '[*]' OR pattern ~ '^[^*]+[*]$'
  ),
  CONSTRAINT endpoint_subscriptions_unique_pattern UNIQUE (endpoint_id, pattern)
);

CREATE INDEX endpoint_subscriptions_endpoint_idx
  ON endpoint_subscriptions (endpoint_id, pattern);

INSERT INTO endpoint_subscriptions (endpoint_id, pattern)
SELECT id, '*'
FROM endpoints;

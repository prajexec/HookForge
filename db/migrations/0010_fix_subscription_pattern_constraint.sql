ALTER TABLE endpoint_subscriptions
  DROP CONSTRAINT endpoint_subscriptions_pattern_format;

ALTER TABLE endpoint_subscriptions
  ADD CONSTRAINT endpoint_subscriptions_pattern_format CHECK (
    pattern = '*' OR pattern !~ '[*]' OR pattern ~ '^[^*]+[*]$'
  );

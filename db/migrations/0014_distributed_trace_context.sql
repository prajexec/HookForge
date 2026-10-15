ALTER TABLE events
  ADD COLUMN source_request_id text,
  ADD COLUMN traceparent text,
  ADD COLUMN tracestate text;

CREATE INDEX events_traceparent_idx
  ON events (traceparent)
  WHERE traceparent IS NOT NULL;

ALTER TABLE deliveries
  DROP CONSTRAINT deliveries_unique_event_endpoint;

ALTER TABLE deliveries
  ADD COLUMN replay_of_delivery_id uuid REFERENCES deliveries(id) ON DELETE CASCADE,
  ADD COLUMN replay_number integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT deliveries_replay_number_check CHECK (replay_number >= 0),
  ADD CONSTRAINT deliveries_replay_source_check CHECK (
    (replay_number = 0 AND replay_of_delivery_id IS NULL)
    OR replay_number > 0
  );

CREATE UNIQUE INDEX deliveries_event_endpoint_replay_idx
  ON deliveries (event_id, endpoint_id, replay_number);
CREATE INDEX deliveries_replay_source_idx
  ON deliveries (replay_of_delivery_id)
  WHERE replay_of_delivery_id IS NOT NULL;

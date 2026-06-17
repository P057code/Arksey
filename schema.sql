-- Arksey level crossing state schema.
-- PostgreSQL 14+.
--
-- Store all rail times as timestamptz. Render them in Europe/London in the
-- application layer so BST/GMT transitions are handled by the database clock.

BEGIN;

CREATE TABLE IF NOT EXISTS tiploc_location (
  tiploc_code varchar(7) PRIMARY KEY,
  display_name text NOT NULL,
  stanox varchar(5),
  crs varchar(3),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tiploc_location_code_format
    CHECK (tiploc_code ~ '^[A-Z0-9]{4,7}$')
);

CREATE TABLE IF NOT EXISTS rail_feed_message (
  id bigserial PRIMARY KEY,
  source text NOT NULL,
  message_type text NOT NULL,
  external_message_id text,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL,
  CONSTRAINT rail_feed_message_source_check CHECK (
    source IN (
      'network_rail_schedule',
      'network_rail_vstp',
      'network_rail_train_movements',
      'darwin',
      'manual'
    )
  )
);

CREATE INDEX IF NOT EXISTS rail_feed_message_received_at_idx
  ON rail_feed_message (received_at DESC);

CREATE INDEX IF NOT EXISTS rail_feed_message_payload_gin_idx
  ON rail_feed_message USING gin (payload);

CREATE TABLE IF NOT EXISTS rail_import_run (
  id bigserial PRIMARY KEY,
  source text NOT NULL,
  import_type text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running',
  records_seen bigint NOT NULL DEFAULT 0,
  records_matched bigint NOT NULL DEFAULT 0,
  records_imported bigint NOT NULL DEFAULT 0,
  error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT rail_import_run_status_check CHECK (
    status IN ('running', 'succeeded', 'failed')
  )
);

CREATE INDEX IF NOT EXISTS rail_import_run_started_at_idx
  ON rail_import_run (started_at DESC);

CREATE TABLE IF NOT EXISTS train_service (
  id bigserial PRIMARY KEY,
  train_uid text,
  schedule_id text,
  service_date date NOT NULL,
  headcode varchar(4),
  trust_train_id text,
  train_service_code text,
  operator_code varchar(2),
  origin_tiploc varchar(7) REFERENCES tiploc_location (tiploc_code),
  destination_tiploc varchar(7) REFERENCES tiploc_location (tiploc_code),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT train_service_identity_present CHECK (
    train_uid IS NOT NULL OR schedule_id IS NOT NULL OR headcode IS NOT NULL
  )
);

ALTER TABLE IF EXISTS train_service
  ADD COLUMN IF NOT EXISTS trust_train_id text,
  ADD COLUMN IF NOT EXISTS train_service_code text,
  ADD COLUMN IF NOT EXISTS origin_tiploc varchar(7) REFERENCES tiploc_location (tiploc_code),
  ADD COLUMN IF NOT EXISTS destination_tiploc varchar(7) REFERENCES tiploc_location (tiploc_code);

DROP INDEX IF EXISTS train_service_identity_uid_idx;
CREATE INDEX IF NOT EXISTS train_service_identity_uid_idx
  ON train_service (train_uid, service_date)
  WHERE train_uid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS train_service_identity_schedule_idx
  ON train_service (schedule_id, service_date)
  WHERE schedule_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS train_service_trust_train_id_idx
  ON train_service (trust_train_id, service_date)
  WHERE trust_train_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS train_passage (
  id bigserial PRIMARY KEY,
  service_id bigint REFERENCES train_service (id) ON DELETE SET NULL,
  tiploc_code varchar(7) NOT NULL REFERENCES tiploc_location (tiploc_code),
  scheduled_pass_at timestamptz NOT NULL,
  estimated_pass_at timestamptz,
  actual_pass_at timestamptz,
  direction_ind text,
  line text,
  path text,
  source_message_id bigint REFERENCES rail_feed_message (id) ON DELETE SET NULL,
  import_run_id bigint REFERENCES rail_import_run (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active',
  confidence text NOT NULL DEFAULT 'scheduled',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT train_passage_status_check CHECK (
    status IN ('active', 'cancelled', 'deleted')
  ),
  CONSTRAINT train_passage_confidence_check CHECK (
    confidence IN ('scheduled', 'estimated', 'actual', 'manual')
  )
);

ALTER TABLE IF EXISTS train_passage
  ADD COLUMN IF NOT EXISTS direction_ind text,
  ADD COLUMN IF NOT EXISTS line text,
  ADD COLUMN IF NOT EXISTS path text,
  ADD COLUMN IF NOT EXISTS import_run_id bigint REFERENCES rail_import_run (id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS train_passage_unique_service_location_time_idx
  ON train_passage (service_id, tiploc_code, scheduled_pass_at)
  WHERE service_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS train_passage_tiploc_effective_time_idx
  ON train_passage (
    tiploc_code,
    (coalesce(actual_pass_at, estimated_pass_at, scheduled_pass_at))
  )
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS train_passage_tiploc_direction_effective_time_idx
  ON train_passage (
    tiploc_code,
    direction_ind,
    (coalesce(actual_pass_at, estimated_pass_at, scheduled_pass_at))
  )
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS train_passage_import_run_idx
  ON train_passage (import_run_id)
  WHERE import_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS level_crossing (
  id bigserial PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  display_name text NOT NULL,
  tiploc_code varchar(7) NOT NULL REFERENCES tiploc_location (tiploc_code),
  timezone text NOT NULL DEFAULT 'Europe/London',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS level_crossing_rule (
  id bigserial PRIMARY KEY,
  crossing_id bigint NOT NULL REFERENCES level_crossing (id) ON DELETE CASCADE,
  closes_before interval NOT NULL DEFAULT interval '3 minutes',
  opens_after interval NOT NULL DEFAULT interval '1 minute',
  effective_from timestamptz NOT NULL DEFAULT '-infinity',
  effective_to timestamptz NOT NULL DEFAULT 'infinity',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT level_crossing_rule_positive_intervals CHECK (
    closes_before >= interval '0 seconds'
    AND opens_after >= interval '0 seconds'
    AND effective_from < effective_to
  )
);

CREATE INDEX IF NOT EXISTS level_crossing_rule_crossing_effective_idx
  ON level_crossing_rule (crossing_id, effective_from, effective_to);

CREATE TABLE IF NOT EXISTS crossing_manual_override (
  id bigserial PRIMARY KEY,
  crossing_id bigint NOT NULL REFERENCES level_crossing (id) ON DELETE CASCADE,
  state text NOT NULL,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL,
  reason text NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crossing_manual_override_state_check
    CHECK (state IN ('open', 'closed')),
  CONSTRAINT crossing_manual_override_time_check
    CHECK (starts_at < ends_at)
);

CREATE INDEX IF NOT EXISTS crossing_manual_override_active_idx
  ON crossing_manual_override (crossing_id, starts_at, ends_at);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tiploc_location_set_updated_at ON tiploc_location;
CREATE TRIGGER tiploc_location_set_updated_at
BEFORE UPDATE ON tiploc_location
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS train_service_set_updated_at ON train_service;
CREATE TRIGGER train_service_set_updated_at
BEFORE UPDATE ON train_service
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS train_passage_set_updated_at ON train_passage;
CREATE TRIGGER train_passage_set_updated_at
BEFORE UPDATE ON train_passage
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS level_crossing_set_updated_at ON level_crossing;
CREATE TRIGGER level_crossing_set_updated_at
BEFORE UPDATE ON level_crossing
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS level_crossing_rule_set_updated_at ON level_crossing_rule;
CREATE TRIGGER level_crossing_rule_set_updated_at
BEFORE UPDATE ON level_crossing_rule
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE VIEW v_train_passage_closure_window AS
SELECT
  p.id AS train_passage_id,
  p.service_id,
  c.id AS crossing_id,
  c.slug AS crossing_slug,
  c.display_name AS crossing_name,
  p.tiploc_code,
  coalesce(p.actual_pass_at, p.estimated_pass_at, p.scheduled_pass_at) AS effective_pass_at,
  p.scheduled_pass_at,
  p.estimated_pass_at,
  p.actual_pass_at,
  p.confidence,
  coalesce(p.actual_pass_at, p.estimated_pass_at, p.scheduled_pass_at) - r.closes_before AS closes_at,
  coalesce(p.actual_pass_at, p.estimated_pass_at, p.scheduled_pass_at) + r.opens_after AS opens_at
FROM train_passage p
JOIN level_crossing c
  ON c.tiploc_code = p.tiploc_code
 AND c.is_active
JOIN level_crossing_rule r
  ON r.crossing_id = c.id
 AND coalesce(p.actual_pass_at, p.estimated_pass_at, p.scheduled_pass_at) >= r.effective_from
 AND coalesce(p.actual_pass_at, p.estimated_pass_at, p.scheduled_pass_at) < r.effective_to
WHERE p.status = 'active';

CREATE OR REPLACE VIEW v_crossing_merged_closure_window AS
WITH ordered AS (
  SELECT
    w.*,
    max(w.opens_at) OVER (
      PARTITION BY w.crossing_id
      ORDER BY w.closes_at, w.opens_at
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) AS previous_max_opens_at
  FROM v_train_passage_closure_window w
),
flagged AS (
  SELECT
    ordered.*,
    CASE
      WHEN previous_max_opens_at IS NULL THEN 1
      WHEN closes_at > previous_max_opens_at THEN 1
      ELSE 0
    END AS starts_new_window
  FROM ordered
),
grouped AS (
  SELECT
    flagged.*,
    sum(starts_new_window) OVER (
      PARTITION BY crossing_id
      ORDER BY closes_at, opens_at
    ) AS window_group
  FROM flagged
)
SELECT
  crossing_id,
  crossing_slug,
  crossing_name,
  tiploc_code,
  min(closes_at) AS closes_at,
  max(opens_at) AS opens_at,
  min(effective_pass_at) AS first_train_pass_at,
  max(effective_pass_at) AS last_train_pass_at,
  array_agg(train_passage_id ORDER BY effective_pass_at, train_passage_id) AS train_passage_ids,
  count(*) AS train_count
FROM grouped
GROUP BY crossing_id, crossing_slug, crossing_name, tiploc_code, window_group;

CREATE OR REPLACE VIEW v_crossing_state AS
SELECT
  c.id AS crossing_id,
  c.slug AS crossing_slug,
  c.display_name AS crossing_name,
  c.tiploc_code,
  CASE
    WHEN active_override.state = 'closed' THEN true
    WHEN active_override.state = 'open' THEN false
    WHEN current_window.crossing_id IS NOT NULL THEN true
    ELSE false
  END AS is_closed,
  CASE
    WHEN active_override.state = 'closed' THEN 'Crossing Closed'
    WHEN active_override.state = 'open' THEN 'Crossing Open'
    WHEN current_window.crossing_id IS NOT NULL THEN 'Crossing Closed'
    ELSE 'Crossing Open'
  END AS public_status,
  current_window.closes_at AS closed_from,
  current_window.opens_at AS opens_at,
  current_window.train_count AS trains_in_current_window,
  current_window.train_passage_ids AS current_train_passage_ids,
  next_window.closes_at AS next_closes_at,
  next_window.opens_at AS next_opens_at,
  next_window.train_count AS next_train_count,
  active_override.reason AS override_reason,
  now() AS calculated_at
FROM level_crossing c
LEFT JOIN LATERAL (
  SELECT o.*
  FROM crossing_manual_override o
  WHERE o.crossing_id = c.id
    AND now() >= o.starts_at
    AND now() < o.ends_at
  ORDER BY o.created_at DESC
  LIMIT 1
) active_override ON true
LEFT JOIN LATERAL (
  SELECT w.*
  FROM v_crossing_merged_closure_window w
  WHERE w.crossing_id = c.id
    AND now() >= w.closes_at
    AND now() < w.opens_at
  ORDER BY w.opens_at DESC
  LIMIT 1
) current_window ON true
LEFT JOIN LATERAL (
  SELECT w.*
  FROM v_crossing_merged_closure_window w
  WHERE w.crossing_id = c.id
    AND w.closes_at > now()
  ORDER BY w.closes_at ASC
  LIMIT 1
) next_window ON true
WHERE c.is_active;

CREATE OR REPLACE VIEW v_crossing_page_payload AS
SELECT
  crossing_slug,
  jsonb_build_object(
    'crossing', crossing_name,
    'tiploc', tiploc_code,
    'isClosed', is_closed,
    'status', public_status,
    'closedFrom', closed_from,
    'opensAt', opens_at,
    'trainsInCurrentWindow', trains_in_current_window,
    'currentTrainPassageIds', current_train_passage_ids,
    'nextClosesAt', next_closes_at,
    'nextOpensAt', next_opens_at,
    'nextTrainCount', next_train_count,
    'overrideReason', override_reason,
    'calculatedAt', calculated_at
  ) AS payload
FROM v_crossing_state;

CREATE OR REPLACE VIEW v_crossing_next_train AS
SELECT
  c.id AS crossing_id,
  c.slug AS crossing_slug,
  c.display_name AS crossing_name,
  p.id AS train_passage_id,
  p.tiploc_code,
  coalesce(nullif(p.direction_ind, ''), 'UNKNOWN') AS direction_ind,
  CASE coalesce(nullif(p.direction_ind, ''), 'UNKNOWN')
    WHEN 'UP' THEN 'Up direction'
    WHEN 'DOWN' THEN 'Down direction'
    ELSE 'Unknown direction'
  END AS direction_label,
  s.headcode,
  s.train_uid,
  s.trust_train_id,
  s.operator_code,
  s.origin_tiploc,
  coalesce(origin.display_name, s.origin_tiploc) AS origin_name,
  s.destination_tiploc,
  coalesce(destination.display_name, s.destination_tiploc) AS destination_name,
  p.scheduled_pass_at,
  p.estimated_pass_at,
  p.actual_pass_at,
  coalesce(p.actual_pass_at, p.estimated_pass_at, p.scheduled_pass_at) AS effective_pass_at,
  CASE
    WHEN p.actual_pass_at IS NOT NULL THEN 'actual'
    WHEN p.estimated_pass_at IS NOT NULL THEN 'live'
    ELSE 'timetable'
  END AS time_source,
  p.line,
  p.path
FROM train_passage p
JOIN level_crossing c
  ON c.tiploc_code = p.tiploc_code
 AND c.is_active
LEFT JOIN train_service s ON s.id = p.service_id
LEFT JOIN tiploc_location origin ON origin.tiploc_code = s.origin_tiploc
LEFT JOIN tiploc_location destination ON destination.tiploc_code = s.destination_tiploc
WHERE p.status = 'active'
  AND coalesce(p.actual_pass_at, p.estimated_pass_at, p.scheduled_pass_at) >= now() - interval '1 minute';

INSERT INTO tiploc_location (tiploc_code, display_name)
VALUES ('ARKSEYL', 'Arksey level crossing')
ON CONFLICT (tiploc_code) DO UPDATE
SET display_name = EXCLUDED.display_name;

INSERT INTO level_crossing (slug, display_name, tiploc_code, timezone)
VALUES ('arksey', 'Arksey Level Crossing', 'ARKSEYL', 'Europe/London')
ON CONFLICT (slug) DO UPDATE
SET
  display_name = EXCLUDED.display_name,
  tiploc_code = EXCLUDED.tiploc_code,
  timezone = EXCLUDED.timezone,
  is_active = true;

INSERT INTO level_crossing_rule (crossing_id, closes_before, opens_after)
SELECT id, interval '3 minutes', interval '1 minute'
FROM level_crossing
WHERE slug = 'arksey'
  AND NOT EXISTS (
    SELECT 1
    FROM level_crossing_rule r
    WHERE r.crossing_id = level_crossing.id
      AND r.effective_to = 'infinity'::timestamptz
  );

COMMIT;

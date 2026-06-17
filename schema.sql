-- Arksey level crossing state schema.
-- MySQL 8.0+ / MariaDB with window-function support.
--
-- Store rail times as UTC DATETIME(3). Render them as Europe/London in the
-- application layer so GMT/BST presentation stays consistent.

START TRANSACTION;

CREATE TABLE IF NOT EXISTS tiploc_location (
  tiploc_code varchar(7) PRIMARY KEY,
  display_name varchar(255) NOT NULL,
  stanox varchar(5),
  crs varchar(3),
  created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT tiploc_location_code_format
    CHECK (tiploc_code REGEXP '^[A-Z0-9]{4,7}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rail_feed_message (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source varchar(64) NOT NULL,
  message_type varchar(64) NOT NULL,
  external_message_id varchar(128),
  received_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  payload json NOT NULL,
  CONSTRAINT rail_feed_message_source_check CHECK (
    source IN (
      'network_rail_schedule',
      'network_rail_vstp',
      'network_rail_train_movements',
      'darwin',
      'manual'
    )
  ),
  INDEX rail_feed_message_received_at_idx (received_at DESC),
  INDEX rail_feed_message_external_message_id_idx (external_message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rail_import_run (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source varchar(64) NOT NULL,
  import_type varchar(64) NOT NULL,
  started_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at datetime(3),
  status varchar(16) NOT NULL DEFAULT 'running',
  records_seen bigint unsigned NOT NULL DEFAULT 0,
  records_matched bigint unsigned NOT NULL DEFAULT 0,
  records_imported bigint unsigned NOT NULL DEFAULT 0,
  error text,
  metadata json NOT NULL,
  CONSTRAINT rail_import_run_status_check CHECK (
    status IN ('running', 'succeeded', 'failed')
  ),
  INDEX rail_import_run_started_at_idx (started_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS train_service (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  train_uid varchar(32),
  schedule_id varchar(255),
  service_date date NOT NULL,
  headcode varchar(4),
  trust_train_id varchar(32),
  train_service_code varchar(32),
  operator_code varchar(8),
  origin_tiploc varchar(7),
  destination_tiploc varchar(7),
  created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT train_service_identity_present CHECK (
    train_uid IS NOT NULL OR schedule_id IS NOT NULL OR headcode IS NOT NULL
  ),
  UNIQUE KEY train_service_identity_schedule_idx (schedule_id, service_date),
  INDEX train_service_identity_uid_idx (train_uid, service_date),
  INDEX train_service_trust_train_id_idx (trust_train_id, service_date),
  CONSTRAINT train_service_origin_fk
    FOREIGN KEY (origin_tiploc) REFERENCES tiploc_location (tiploc_code),
  CONSTRAINT train_service_destination_fk
    FOREIGN KEY (destination_tiploc) REFERENCES tiploc_location (tiploc_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS train_passage (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  service_id bigint unsigned,
  tiploc_code varchar(7) NOT NULL,
  scheduled_pass_at datetime(3) NOT NULL,
  estimated_pass_at datetime(3),
  actual_pass_at datetime(3),
  direction_ind varchar(16),
  line varchar(16),
  path varchar(16),
  source_message_id bigint unsigned,
  import_run_id bigint unsigned,
  status varchar(16) NOT NULL DEFAULT 'active',
  confidence varchar(16) NOT NULL DEFAULT 'scheduled',
  created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT train_passage_status_check CHECK (
    status IN ('active', 'cancelled', 'deleted')
  ),
  CONSTRAINT train_passage_confidence_check CHECK (
    confidence IN ('scheduled', 'estimated', 'actual', 'manual')
  ),
  UNIQUE KEY train_passage_unique_service_location_time_idx (
    service_id,
    tiploc_code,
    scheduled_pass_at
  ),
  INDEX train_passage_tiploc_effective_time_idx (
    tiploc_code,
    status,
    scheduled_pass_at,
    estimated_pass_at,
    actual_pass_at
  ),
  INDEX train_passage_tiploc_direction_effective_time_idx (
    tiploc_code,
    direction_ind,
    status,
    scheduled_pass_at,
    estimated_pass_at,
    actual_pass_at
  ),
  INDEX train_passage_import_run_idx (import_run_id),
  CONSTRAINT train_passage_service_fk
    FOREIGN KEY (service_id) REFERENCES train_service (id) ON DELETE SET NULL,
  CONSTRAINT train_passage_tiploc_fk
    FOREIGN KEY (tiploc_code) REFERENCES tiploc_location (tiploc_code),
  CONSTRAINT train_passage_source_message_fk
    FOREIGN KEY (source_message_id) REFERENCES rail_feed_message (id) ON DELETE SET NULL,
  CONSTRAINT train_passage_import_run_fk
    FOREIGN KEY (import_run_id) REFERENCES rail_import_run (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS level_crossing (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  slug varchar(80) NOT NULL UNIQUE,
  display_name varchar(255) NOT NULL,
  tiploc_code varchar(7) NOT NULL,
  timezone varchar(64) NOT NULL DEFAULT 'Europe/London',
  is_active boolean NOT NULL DEFAULT true,
  created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT level_crossing_tiploc_fk
    FOREIGN KEY (tiploc_code) REFERENCES tiploc_location (tiploc_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS level_crossing_rule (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  crossing_id bigint unsigned NOT NULL,
  closes_before_seconds int unsigned NOT NULL DEFAULT 180,
  opens_after_seconds int unsigned NOT NULL DEFAULT 60,
  effective_from datetime(3) NOT NULL DEFAULT '1000-01-01 00:00:00.000',
  effective_to datetime(3) NOT NULL DEFAULT '9999-12-31 23:59:59.999',
  created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT level_crossing_rule_time_check CHECK (effective_from < effective_to),
  INDEX level_crossing_rule_crossing_effective_idx (crossing_id, effective_from, effective_to),
  CONSTRAINT level_crossing_rule_crossing_fk
    FOREIGN KEY (crossing_id) REFERENCES level_crossing (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS crossing_manual_override (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  crossing_id bigint unsigned NOT NULL,
  state varchar(16) NOT NULL,
  starts_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ends_at datetime(3) NOT NULL,
  reason text NOT NULL,
  created_by varchar(255),
  created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT crossing_manual_override_state_check
    CHECK (state IN ('open', 'closed')),
  CONSTRAINT crossing_manual_override_time_check
    CHECK (starts_at < ends_at),
  INDEX crossing_manual_override_active_idx (crossing_id, starts_at, ends_at),
  CONSTRAINT crossing_manual_override_crossing_fk
    FOREIGN KEY (crossing_id) REFERENCES level_crossing (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP VIEW IF EXISTS v_crossing_page_payload;
DROP VIEW IF EXISTS v_crossing_state;
DROP VIEW IF EXISTS v_crossing_next_train;
DROP VIEW IF EXISTS v_crossing_merged_closure_window;
DROP VIEW IF EXISTS v_train_passage_closure_window;

CREATE VIEW v_train_passage_closure_window AS
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
  date_sub(
    coalesce(p.actual_pass_at, p.estimated_pass_at, p.scheduled_pass_at),
    INTERVAL r.closes_before_seconds SECOND
  ) AS closes_at,
  date_add(
    coalesce(p.actual_pass_at, p.estimated_pass_at, p.scheduled_pass_at),
    INTERVAL r.opens_after_seconds SECOND
  ) AS opens_at
FROM train_passage p
JOIN level_crossing c
  ON c.tiploc_code = p.tiploc_code
 AND c.is_active = true
JOIN level_crossing_rule r
  ON r.crossing_id = c.id
 AND coalesce(p.actual_pass_at, p.estimated_pass_at, p.scheduled_pass_at) >= r.effective_from
 AND coalesce(p.actual_pass_at, p.estimated_pass_at, p.scheduled_pass_at) < r.effective_to
WHERE p.status = 'active';

CREATE VIEW v_crossing_merged_closure_window AS
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
  json_arrayagg(train_passage_id) AS train_passage_ids,
  count(*) AS train_count
FROM grouped
GROUP BY crossing_id, crossing_slug, crossing_name, tiploc_code, window_group;

CREATE VIEW v_crossing_state AS
WITH active_override AS (
  SELECT *
  FROM (
    SELECT
      o.*,
      row_number() OVER (
        PARTITION BY o.crossing_id
        ORDER BY o.created_at DESC, o.id DESC
      ) AS rn
    FROM crossing_manual_override o
    WHERE utc_timestamp(3) >= o.starts_at
      AND utc_timestamp(3) < o.ends_at
  ) ranked
  WHERE rn = 1
),
current_window AS (
  SELECT *
  FROM (
    SELECT
      w.*,
      row_number() OVER (
        PARTITION BY w.crossing_id
        ORDER BY w.opens_at DESC
      ) AS rn
    FROM v_crossing_merged_closure_window w
    WHERE utc_timestamp(3) >= w.closes_at
      AND utc_timestamp(3) < w.opens_at
  ) ranked
  WHERE rn = 1
),
next_window AS (
  SELECT *
  FROM (
    SELECT
      w.*,
      row_number() OVER (
        PARTITION BY w.crossing_id
        ORDER BY w.closes_at ASC
      ) AS rn
    FROM v_crossing_merged_closure_window w
    WHERE w.closes_at > utc_timestamp(3)
  ) ranked
  WHERE rn = 1
)
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
  utc_timestamp(3) AS calculated_at
FROM level_crossing c
LEFT JOIN active_override
  ON active_override.crossing_id = c.id
LEFT JOIN current_window
  ON current_window.crossing_id = c.id
LEFT JOIN next_window
  ON next_window.crossing_id = c.id
WHERE c.is_active = true;

CREATE VIEW v_crossing_page_payload AS
SELECT
  crossing_slug,
  json_object(
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

CREATE VIEW v_crossing_next_train AS
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
 AND c.is_active = true
LEFT JOIN train_service s ON s.id = p.service_id
LEFT JOIN tiploc_location origin ON origin.tiploc_code = s.origin_tiploc
LEFT JOIN tiploc_location destination ON destination.tiploc_code = s.destination_tiploc
WHERE p.status = 'active'
  AND coalesce(p.actual_pass_at, p.estimated_pass_at, p.scheduled_pass_at) >= date_sub(utc_timestamp(3), INTERVAL 1 MINUTE);

INSERT INTO tiploc_location (tiploc_code, display_name)
VALUES ('ARKSEYL', 'Arksey level crossing')
ON DUPLICATE KEY UPDATE display_name = VALUES(display_name);

INSERT INTO level_crossing (slug, display_name, tiploc_code, timezone, is_active)
VALUES ('arksey', 'Arksey Level Crossing', 'ARKSEYL', 'Europe/London', true)
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  tiploc_code = VALUES(tiploc_code),
  timezone = VALUES(timezone),
  is_active = true;

INSERT INTO level_crossing_rule (crossing_id, closes_before_seconds, opens_after_seconds)
SELECT id, 180, 60
FROM level_crossing
WHERE slug = 'arksey'
  AND NOT EXISTS (
    SELECT 1
    FROM level_crossing_rule r
    WHERE r.crossing_id = level_crossing.id
      AND r.effective_to = '9999-12-31 23:59:59.999'
  );

COMMIT;

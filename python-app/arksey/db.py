import json
from contextlib import contextmanager
from urllib.parse import parse_qs, unquote, urlparse

import pymysql
from pymysql.cursors import DictCursor


class Database:
    def __init__(self, database_url):
        self.options = parse_database_url(database_url)

    @contextmanager
    def connection(self):
        connection = pymysql.connect(
            **self.options,
            cursorclass=DictCursor,
            autocommit=False,
        )
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def fetch_one(self, sql, params=()):
        with self.connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(sql, params)
                return cursor.fetchone()

    def fetch_all(self, sql, params=()):
        with self.connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(sql, params)
                return cursor.fetchall()

    def execute(self, sql, params=()):
        with self.connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(sql, params)
                return cursor.rowcount, cursor.lastrowid

    def get_target_stanox(self, tiploc):
        row = self.fetch_one(
            "SELECT stanox FROM tiploc_location WHERE tiploc_code = %s",
            (tiploc,),
        )
        return row["stanox"] if row else None

    def upsert_tiploc(self, tiploc_code, display_name=None, stanox=None, crs=None):
        self.execute(
            """
            INSERT INTO tiploc_location (tiploc_code, display_name, stanox, crs)
            VALUES (%s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              display_name = CASE
                WHEN VALUES(display_name) = VALUES(tiploc_code) THEN display_name
                ELSE VALUES(display_name)
              END,
              stanox = coalesce(VALUES(stanox), stanox),
              crs = coalesce(VALUES(crs), crs)
            """,
            (tiploc_code, display_name or tiploc_code, stanox, crs),
        )

    def start_import_run(self, source, import_type, metadata):
        _, import_id = self.execute(
            """
            INSERT INTO rail_import_run (source, import_type, metadata)
            VALUES (%s, %s, %s)
            """,
            (source, import_type, json.dumps(metadata)),
        )
        return import_id

    def finish_import_run(self, import_id, status, stats, error=None):
        self.execute(
            """
            UPDATE rail_import_run
            SET finished_at = utc_timestamp(3),
                status = %s,
                records_seen = %s,
                records_matched = %s,
                records_imported = %s,
                error = %s
            WHERE id = %s
            """,
            (
                status,
                stats["records_seen"],
                stats["records_matched"],
                stats["records_imported"],
                error,
                import_id,
            ),
        )

    def insert_feed_message(
        self,
        source,
        message_type,
        payload,
        external_message_id=None,
    ):
        _, message_id = self.execute(
            """
            INSERT INTO rail_feed_message
              (source, message_type, external_message_id, payload)
            VALUES (%s, %s, %s, %s)
            """,
            (
                source,
                message_type,
                external_message_id,
                json.dumps(payload),
            ),
        )
        return message_id

    def upsert_service(self, service):
        self.execute(
            """
            INSERT INTO train_service (
              train_uid,
              schedule_id,
              service_date,
              headcode,
              trust_train_id,
              train_service_code,
              operator_code,
              origin_tiploc,
              destination_tiploc
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              train_uid = coalesce(VALUES(train_uid), train_uid),
              headcode = coalesce(VALUES(headcode), headcode),
              trust_train_id = coalesce(VALUES(trust_train_id), trust_train_id),
              train_service_code = coalesce(
                VALUES(train_service_code),
                train_service_code
              ),
              operator_code = coalesce(VALUES(operator_code), operator_code),
              origin_tiploc = coalesce(VALUES(origin_tiploc), origin_tiploc),
              destination_tiploc = coalesce(
                VALUES(destination_tiploc),
                destination_tiploc
              )
            """,
            (
                service.get("train_uid"),
                service["schedule_id"],
                service["service_date"],
                service.get("headcode"),
                service.get("trust_train_id"),
                service.get("train_service_code"),
                service.get("operator_code"),
                service.get("origin_tiploc"),
                service.get("destination_tiploc"),
            ),
        )
        row = self.fetch_one(
            """
            SELECT id FROM train_service
            WHERE schedule_id = %s AND service_date = %s
            LIMIT 1
            """,
            (service["schedule_id"], service["service_date"]),
        )
        return row["id"]

    def upsert_passage(self, passage):
        self.execute(
            """
            INSERT INTO train_passage (
              service_id,
              tiploc_code,
              scheduled_pass_at,
              estimated_pass_at,
              actual_pass_at,
              direction_ind,
              line,
              path,
              source_message_id,
              import_run_id,
              status,
              confidence
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              estimated_pass_at = coalesce(
                VALUES(estimated_pass_at),
                estimated_pass_at
              ),
              actual_pass_at = coalesce(VALUES(actual_pass_at), actual_pass_at),
              direction_ind = coalesce(VALUES(direction_ind), direction_ind),
              line = coalesce(VALUES(line), line),
              path = coalesce(VALUES(path), path),
              source_message_id = coalesce(
                VALUES(source_message_id),
                source_message_id
              ),
              import_run_id = coalesce(VALUES(import_run_id), import_run_id),
              status = VALUES(status),
              confidence = VALUES(confidence)
            """,
            (
                passage["service_id"],
                passage["tiploc_code"],
                passage["scheduled_pass_at"],
                passage.get("estimated_pass_at"),
                passage.get("actual_pass_at"),
                passage.get("direction_ind"),
                passage.get("line"),
                passage.get("path"),
                passage.get("source_message_id"),
                passage.get("import_run_id"),
                passage.get("status", "active"),
                passage.get("confidence", "scheduled"),
            ),
        )

    def mark_stale_schedule_passages(
        self,
        target_tiploc,
        import_run_id,
        from_date,
        through_date,
    ):
        row_count, _ = self.execute(
            """
            UPDATE train_passage p
            JOIN rail_feed_message m ON p.source_message_id = m.id
            SET p.status = 'deleted'
            WHERE m.source = 'network_rail_schedule'
              AND p.tiploc_code = %s
              AND (p.import_run_id <> %s OR p.import_run_id IS NULL)
              AND p.scheduled_pass_at >= %s
              AND p.scheduled_pass_at < date_add(%s, INTERVAL 1 DAY)
              AND p.status = 'active'
            """,
            (
                target_tiploc,
                import_run_id,
                from_date,
                through_date,
            ),
        )
        return row_count

    def apply_actual_movement(
        self,
        target_tiploc,
        train_id,
        headcode,
        service_date,
        planned_at,
        actual_at,
        direction_ind,
        source_message_id,
    ):
        reference_time = planned_at or actual_at
        row = self.fetch_one(
            """
            SELECT p.id
            FROM train_passage p
            JOIN train_service s ON s.id = p.service_id
            WHERE p.tiploc_code = %s
              AND s.service_date BETWEEN
                date_sub(%s, INTERVAL 1 DAY)
                AND date_add(%s, INTERVAL 1 DAY)
              AND (%s IS NULL OR s.headcode = %s)
              AND p.scheduled_pass_at BETWEEN
                date_sub(%s, INTERVAL 120 MINUTE)
                AND date_add(%s, INTERVAL 120 MINUTE)
            ORDER BY abs(
              timestampdiff(SECOND, p.scheduled_pass_at, %s)
            )
            LIMIT 1
            """,
            (
                target_tiploc,
                service_date,
                service_date,
                headcode,
                headcode,
                reference_time,
                reference_time,
                reference_time,
            ),
        )

        if row:
            self.execute(
                """
                UPDATE train_passage
                SET actual_pass_at = %s,
                    direction_ind = coalesce(%s, direction_ind),
                    source_message_id = %s,
                    confidence = 'actual'
                WHERE id = %s
                """,
                (
                    actual_at,
                    direction_ind,
                    source_message_id,
                    row["id"],
                ),
            )
            return "updated"

        service_id = self.upsert_service(
            {
                "schedule_id": f"trust:{train_id}:{service_date}",
                "service_date": service_date,
                "headcode": headcode,
                "trust_train_id": train_id,
            }
        )
        self.upsert_passage(
            {
                "service_id": service_id,
                "tiploc_code": target_tiploc,
                "scheduled_pass_at": reference_time,
                "actual_pass_at": actual_at,
                "direction_ind": direction_ind,
                "source_message_id": source_message_id,
                "confidence": "actual",
            }
        )
        return "inserted"

    def dashboard(self, crossing_slug="arksey"):
        crossing = self.fetch_one(
            """
            SELECT * FROM v_crossing_state
            WHERE crossing_slug = %s
            LIMIT 1
            """,
            (crossing_slug,),
        )
        directions = self.fetch_all(
            """
            WITH ranked AS (
              SELECT
                v_crossing_next_train.*,
                row_number() OVER (
                  PARTITION BY direction_ind
                  ORDER BY effective_pass_at, train_passage_id
                ) AS direction_rank
              FROM v_crossing_next_train
              WHERE crossing_slug = %s
            )
            SELECT * FROM ranked
            WHERE direction_rank = 1
            ORDER BY
              CASE direction_ind
                WHEN 'UP' THEN 1
                WHEN 'DOWN' THEN 2
                ELSE 3
              END,
              effective_pass_at
            LIMIT 4
            """,
            (crossing_slug,),
        )
        upcoming = self.fetch_all(
            """
            SELECT * FROM v_crossing_next_train
            WHERE crossing_slug = %s
            ORDER BY effective_pass_at, train_passage_id
            LIMIT 6
            """,
            (crossing_slug,),
        )
        return {
            "crossing": crossing,
            "next_by_direction": directions,
            "next_overall": upcoming,
        }


def parse_database_url(database_url):
    parsed = urlparse(database_url)
    if parsed.scheme not in {"mysql", "mysql+pymysql"}:
        raise RuntimeError("DATABASE_URL must use mysql://")

    query = parse_qs(parsed.query)
    options = {
        "host": parsed.hostname or "localhost",
        "port": parsed.port or 3306,
        "user": unquote(parsed.username or ""),
        "password": unquote(parsed.password or ""),
        "database": parsed.path.lstrip("/"),
        "charset": "utf8mb4",
    }
    if query.get("sslmode", [""])[0] == "require":
        options["ssl"] = {}
    return options

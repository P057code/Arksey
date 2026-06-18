import gzip
import io
import json
import traceback
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import requests

from .db import Database
from .parsers import (
    expand_run_dates,
    find_target_location,
    get_route_endpoints,
    get_schedule_locations,
    schedule_datetime,
)


class ScheduleImporter:
    def __init__(self, config):
        self.config = config
        self.db = Database(config.database_url)

    def import_daily_schedule(self):
        run_id = self.db.start_import_run(
            "network_rail_schedule",
            "daily_json",
            {
                "type": self.config.schedule.schedule_type,
                "day": self.config.schedule.day,
                "targetTiploc": self.config.target_tiploc,
                "lookaheadDays": self.config.schedule.lookahead_days,
            },
        )
        stats = {
            "records_seen": 0,
            "records_matched": 0,
            "records_imported": 0,
        }

        try:
            with requests.get(
                self.schedule_url(),
                auth=(
                    self.config.openrail.username,
                    self.config.openrail.password,
                ),
                stream=True,
                timeout=(20, 300),
            ) as response:
                response.raise_for_status()
                response.raw.decode_content = False
                with gzip.GzipFile(fileobj=response.raw) as compressed:
                    text_stream = io.TextIOWrapper(
                        compressed,
                        encoding="utf-8",
                    )
                    for line in text_stream:
                        if not line.strip():
                            continue
                        stats["records_seen"] += 1
                        record = json.loads(line)

                        if record.get("TiplocV1"):
                            self.import_tiploc(record["TiplocV1"])
                            continue

                        schedule = record.get("JsonScheduleV1")
                        if not schedule:
                            continue

                        matched, imported = self.import_schedule(
                            schedule,
                            record,
                            run_id,
                        )
                        if matched:
                            stats["records_matched"] += 1
                        stats["records_imported"] += imported

            if "_FULL_" in self.config.schedule.schedule_type:
                self.cleanup_stale(run_id)

            self.db.finish_import_run(run_id, "succeeded", stats)
            return stats
        except Exception as error:
            self.db.finish_import_run(
                run_id,
                "failed",
                stats,
                traceback.format_exc(),
            )
            raise error

    def import_tiploc(self, record):
        tiploc_code = record.get("tiploc_code") or record.get("tiploc")
        if not tiploc_code:
            return
        self.db.upsert_tiploc(
            tiploc_code=tiploc_code,
            display_name=(
                record.get("description")
                or record.get("name")
                or tiploc_code
            ),
            stanox=record.get("stanox"),
            crs=record.get("crs_code"),
        )

    def import_schedule(self, schedule, raw_record, run_id):
        locations = get_schedule_locations(schedule)
        target = find_target_location(
            locations,
            self.config.target_tiploc,
        )
        if not target:
            return False, 0

        endpoints = get_route_endpoints(locations)
        self.ensure_endpoints(endpoints)
        run_dates = expand_run_dates(
            schedule,
            self.config.schedule.lookahead_days,
        )
        if not run_dates:
            return True, 0

        source_message_id = self.db.insert_feed_message(
            "network_rail_schedule",
            "JsonScheduleV1",
            raw_record,
            schedule.get("CIF_train_uid"),
        )
        segment = schedule.get("schedule_segment") or {}
        if isinstance(segment, list):
            segment = segment[0] if segment else {}

        count = 0
        for service_date in run_dates:
            schedule_id = ":".join(
                str(value or "")
                for value in (
                    "schedule",
                    schedule.get("CIF_train_uid"),
                    schedule.get("schedule_start_date"),
                    schedule.get("schedule_end_date"),
                    schedule.get("CIF_stp_indicator"),
                    service_date,
                )
            )
            cancelled = (
                str(schedule.get("transaction_type", "")).lower()
                == "delete"
                or schedule.get("CIF_stp_indicator") == "C"
            )
            service_id = self.db.upsert_service(
                {
                    "train_uid": schedule.get("CIF_train_uid"),
                    "schedule_id": schedule_id,
                    "service_date": service_date,
                    "headcode": (
                        segment.get("signalling_id")
                        or segment.get("CIF_headcode")
                    ),
                    "train_service_code": segment.get(
                        "CIF_train_service_code"
                    ),
                    "operator_code": schedule.get("atoc_code"),
                    **endpoints,
                }
            )
            self.db.upsert_passage(
                {
                    "service_id": service_id,
                    "tiploc_code": self.config.target_tiploc,
                    "scheduled_pass_at": schedule_datetime(
                        service_date,
                        target["seconds_after_midnight"],
                        target["day_offset"],
                    ),
                    "direction_ind": target["direction_ind"],
                    "line": target["line"],
                    "path": target["path"],
                    "source_message_id": source_message_id,
                    "import_run_id": run_id,
                    "status": "cancelled" if cancelled else "active",
                    "confidence": "scheduled",
                }
            )
            count += 1
        return True, count

    def ensure_endpoints(self, endpoints):
        for tiploc_code in (
            endpoints["origin_tiploc"],
            endpoints["destination_tiploc"],
        ):
            if tiploc_code:
                self.db.upsert_tiploc(tiploc_code, tiploc_code)

    def cleanup_stale(self, run_id):
        london = ZoneInfo(self.config.schedule.timezone)
        from_date = datetime.now(london).date()
        through_date = from_date + timedelta(
            days=self.config.schedule.lookahead_days - 1
        )
        return self.db.mark_stale_schedule_passages(
            self.config.target_tiploc,
            run_id,
            from_date,
            through_date,
        )

    def schedule_url(self):
        return (
            "https://publicdatafeeds.networkrail.co.uk/"
            "ntrod/CifFileAuthenticate"
            f"?type={self.config.schedule.schedule_type}"
            f"&day={self.config.schedule.day}"
        )

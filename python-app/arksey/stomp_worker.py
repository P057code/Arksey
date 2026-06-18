import json
import logging
import threading
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import stomp

from .db import Database
from .parsers import (
    extract_headcode_from_trust_train_id,
    find_target_location,
    get_route_endpoints,
    get_schedule_locations,
    normalise_direction,
    normalise_records,
    parse_epoch_millis,
    schedule_datetime,
    service_date_from_instant,
)
from .schedule_importer import ScheduleImporter


LOGGER = logging.getLogger(__name__)


class FeedListener(stomp.ConnectionListener):
    def __init__(self, worker):
        self.worker = worker

    def on_error(self, frame):
        LOGGER.error("STOMP broker error: %s", frame.body)

    def on_disconnected(self):
        LOGGER.warning("STOMP disconnected")

    def on_message(self, frame):
        try:
            topic = frame.headers.get("destination", "").split("/")[-1]
            self.worker.process_message(topic, frame.body)
            message_id = frame.headers.get("message-id")
            subscription = frame.headers.get("subscription")
            if message_id and subscription:
                self.worker.connection.ack(message_id, subscription)
        except Exception:
            LOGGER.exception("Failed to process STOMP message")


class StompWorker:
    def __init__(self, config):
        self.config = config
        self.db = Database(config.database_url)
        self.connection = stomp.Connection12(
            [(config.openrail.stomp_host, config.openrail.stomp_port)],
            heartbeats=(10000, 10000),
            keepalive=True,
        )
        self.connection.set_listener("arksey", FeedListener(self))

    def run_forever(self):
        self.connection.connect(
            login=self.config.openrail.username,
            passcode=self.config.openrail.password,
            wait=True,
            headers={
                "client-id": self.config.openrail.stomp_client_id,
            },
        )
        for index, topic in enumerate(self.config.openrail.stomp_topics):
            headers = {}
            if self.config.openrail.durable_subscription:
                headers["activemq.subscriptionName"] = (
                    f"{self.config.openrail.stomp_client_id}-{topic}"
                )
            self.connection.subscribe(
                destination=f"/topic/{topic}",
                id=f"arksey-{index}",
                ack="client-individual",
                headers=headers,
            )
        LOGGER.info("Connected to OpenRailData STOMP feeds")

        while True:
            if not self.connection.is_connected():
                raise RuntimeError("STOMP connection closed")
            time.sleep(5)

    def process_message(self, topic, body):
        payload = json.loads(body)
        for record in normalise_records(payload):
            if topic == "TRAIN_MVT_ALL_TOC":
                self.process_movement(record)
            elif topic == "VSTP_ALL":
                self.process_vstp(record)
            else:
                self.db.insert_feed_message(
                    "network_rail_train_movements",
                    topic,
                    record,
                )

    def process_movement(self, record):
        header = record.get("header") or {}
        body = record.get("body") or {}
        message_type = header.get("msg_type") or "unknown"
        source_message_id = self.db.insert_feed_message(
            "network_rail_train_movements",
            message_type,
            record,
            body.get("train_id"),
        )
        if message_type != "0003":
            return

        target_stanox = (
            self.config.target_stanox
            or self.db.get_target_stanox(self.config.target_tiploc)
        )
        if not target_stanox:
            return
        if (body.get("loc_stanox") or body.get("reporting_stanox")) != target_stanox:
            return

        actual_at = parse_epoch_millis(body.get("actual_timestamp"))
        planned_at = parse_epoch_millis(
            body.get("planned_timestamp") or body.get("gbtt_timestamp")
        )
        if not actual_at and not planned_at:
            return

        reference_time = planned_at or actual_at
        train_id = (
            body.get("train_id")
            or body.get("current_train_id")
            or "unknown"
        )
        self.db.apply_actual_movement(
            target_tiploc=self.config.target_tiploc,
            train_id=train_id,
            headcode=extract_headcode_from_trust_train_id(train_id),
            service_date=service_date_from_instant(reference_time),
            planned_at=planned_at or actual_at,
            actual_at=actual_at or planned_at,
            direction_ind=normalise_direction(body.get("direction_ind")),
            source_message_id=source_message_id,
        )

    def process_vstp(self, record):
        wrapper = record.get("VSTPCIFMsgV1") or record
        schedule = wrapper.get("schedule")
        source_message_id = self.db.insert_feed_message(
            "network_rail_vstp",
            "VSTPCIFMsgV1",
            record,
            wrapper.get("originMsgId")
            or (schedule or {}).get("schedule_id"),
        )
        if not schedule:
            return

        locations = get_schedule_locations(schedule)
        target = find_target_location(
            locations,
            self.config.target_tiploc,
            vstp=True,
        )
        service_date = schedule.get("schedule_start_date")
        if not target or not service_date:
            return

        endpoints = get_route_endpoints(locations, vstp=True)
        for tiploc_code in endpoints.values():
            if tiploc_code:
                self.db.upsert_tiploc(tiploc_code, tiploc_code)

        segment = schedule.get("schedule_segment") or {}
        if isinstance(segment, list):
            segment = segment[0] if segment else {}

        schedule_id = ":".join(
            str(value or "")
            for value in (
                "vstp",
                schedule.get("CIF_train_uid"),
                service_date,
                schedule.get("CIF_stp_indicator"),
                wrapper.get("originMsgId") or schedule.get("schedule_id"),
            )
        )
        cancelled = (
            str(schedule.get("transaction_type", "")).lower() == "delete"
            or schedule.get("CIF_stp_indicator") == "C"
        )
        service_id = self.db.upsert_service(
            {
                "train_uid": (schedule.get("CIF_train_uid") or "").strip()
                or None,
                "schedule_id": schedule_id,
                "service_date": service_date,
                "headcode": (
                    segment.get("signalling_id")
                    or segment.get("CIF_headcode")
                ),
                "train_service_code": segment.get(
                    "CIF_train_service_code"
                ),
                "operator_code": (
                    segment.get("atoc_code")
                    or schedule.get("atoc_code")
                ),
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
                "status": "cancelled" if cancelled else "active",
                "confidence": "scheduled",
            }
        )


def start_daily_import_thread(config):
    def run():
        london = ZoneInfo(config.schedule.timezone)
        importer = ScheduleImporter(config)
        if config.schedule.import_on_start:
            importer.import_daily_schedule()

        while True:
            now = datetime.now(london)
            hour, minute = (
                int(value)
                for value in config.schedule.daily_time.split(":", 1)
            )
            next_run = now.replace(
                hour=hour,
                minute=minute,
                second=0,
                microsecond=0,
            )
            if next_run <= now:
                next_run += timedelta(days=1)
            time.sleep((next_run - now).total_seconds())
            try:
                importer.import_daily_schedule()
            except Exception:
                LOGGER.exception("Daily schedule import failed")

    thread = threading.Thread(
        target=run,
        name="daily-schedule-import",
        daemon=True,
    )
    thread.start()
    return thread

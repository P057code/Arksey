import os
from dataclasses import dataclass

from dotenv import load_dotenv


@dataclass(frozen=True)
class OpenRailConfig:
    username: str
    password: str
    stomp_host: str
    stomp_port: int
    stomp_topics: tuple[str, ...]
    stomp_client_id: str
    durable_subscription: bool


@dataclass(frozen=True)
class ScheduleConfig:
    daily_time: str
    timezone: str
    lookahead_days: int
    schedule_type: str
    day: str
    import_on_start: bool


@dataclass(frozen=True)
class Config:
    database_url: str
    port: int
    debug: bool
    target_tiploc: str
    target_stanox: str
    openrail: OpenRailConfig
    schedule: ScheduleConfig


def load_config(require_openrail=False):
    load_dotenv()

    database_url = _required("DATABASE_URL")
    username = os.getenv("OPENRAIL_USERNAME", "")
    password = os.getenv("OPENRAIL_PASSWORD", "")

    if require_openrail:
        if not username:
            raise RuntimeError("Missing OPENRAIL_USERNAME")
        if not password:
            raise RuntimeError("Missing OPENRAIL_PASSWORD")

    return Config(
        database_url=database_url,
        port=_integer("PORT", 5000),
        debug=_boolean("FLASK_DEBUG", False),
        target_tiploc=os.getenv("TARGET_TIPLOC", "ARKSEYL"),
        target_stanox=os.getenv("TARGET_STANOX", ""),
        openrail=OpenRailConfig(
            username=username,
            password=password,
            stomp_host=os.getenv(
                "OPENRAIL_STOMP_HOST",
                "publicdatafeeds.networkrail.co.uk",
            ),
            stomp_port=_integer("OPENRAIL_STOMP_PORT", 61618),
            stomp_topics=tuple(
                item.strip()
                for item in os.getenv(
                    "OPENRAIL_STOMP_TOPICS",
                    "TRAIN_MVT_ALL_TOC,VSTP_ALL",
                ).split(",")
                if item.strip()
            ),
            stomp_client_id=os.getenv(
                "OPENRAIL_STOMP_CLIENT_ID",
                "arksey-python",
            ),
            durable_subscription=_boolean("OPENRAIL_STOMP_DURABLE", True),
        ),
        schedule=ScheduleConfig(
            daily_time=os.getenv("SCHEDULE_DAILY_TIME", "06:15"),
            timezone=os.getenv("SCHEDULE_TIMEZONE", "Europe/London"),
            lookahead_days=_integer("SCHEDULE_LOOKAHEAD_DAYS", 3),
            schedule_type=os.getenv(
                "SCHEDULE_TYPE",
                "CIF_ALL_FULL_DAILY",
            ),
            day=os.getenv("SCHEDULE_DAY", "toc-full"),
            import_on_start=_boolean("SCHEDULE_IMPORT_ON_START", False),
        ),
    )


def _required(name):
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable {name}")
    return value


def _integer(name, default):
    value = os.getenv(name)
    return default if not value else int(value)


def _boolean(name, default):
    value = os.getenv(name)
    if value is None or value == "":
        return default
    return value.lower() in {"1", "true", "yes", "y"}

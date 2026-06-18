from datetime import date, datetime, timezone

from flask import Blueprint, current_app, jsonify, render_template

from .db import Database


web = Blueprint("web", __name__)


@web.get("/")
def index():
    return render_template("index.html")


@web.get("/health")
def health():
    return jsonify({"ok": True})


@web.get("/api/status")
def status():
    config = current_app.config["ARKSEY"]
    dashboard = Database(config.database_url).dashboard("arksey")
    return jsonify(
        {
            "crossing": map_crossing(dashboard["crossing"]),
            "nextByDirection": [
                map_train(train)
                for train in dashboard["next_by_direction"]
            ],
            "nextOverall": [
                map_train(train)
                for train in dashboard["next_overall"]
            ],
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
        }
    )


def map_crossing(row):
    if not row:
        return None
    return {
        "id": row["crossing_id"],
        "slug": row["crossing_slug"],
        "name": row["crossing_name"],
        "tiploc": row["tiploc_code"],
        "isClosed": bool(row["is_closed"]),
        "status": row["public_status"],
        "closedFrom": iso_value(row["closed_from"]),
        "opensAt": iso_value(row["opens_at"]),
        "trainsInCurrentWindow": row["trains_in_current_window"],
        "nextClosesAt": iso_value(row["next_closes_at"]),
        "nextOpensAt": iso_value(row["next_opens_at"]),
        "nextTrainCount": row["next_train_count"],
        "overrideReason": row["override_reason"],
        "calculatedAt": iso_value(row["calculated_at"]),
    }


def map_train(row):
    return {
        "id": row["train_passage_id"],
        "direction": row["direction_ind"],
        "directionLabel": row["direction_label"],
        "headcode": row["headcode"],
        "trainUid": row["train_uid"],
        "trustTrainId": row["trust_train_id"],
        "operatorCode": row["operator_code"],
        "originTiploc": row["origin_tiploc"],
        "originName": row["origin_name"],
        "destinationTiploc": row["destination_tiploc"],
        "destinationName": row["destination_name"],
        "scheduledPassAt": iso_value(row["scheduled_pass_at"]),
        "estimatedPassAt": iso_value(row["estimated_pass_at"]),
        "actualPassAt": iso_value(row["actual_pass_at"]),
        "effectivePassAt": iso_value(row["effective_pass_at"]),
        "timeSource": row["time_source"],
        "line": row["line"],
        "path": row["path"],
    }


def iso_value(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=timezone.utc).isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return value

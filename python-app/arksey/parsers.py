from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo


LONDON = ZoneInfo("Europe/London")


def parse_epoch_millis(value):
    if value in (None, ""):
        return None
    return datetime.fromtimestamp(int(value) / 1000, tz=timezone.utc).replace(
        tzinfo=None
    )


def service_date_from_instant(value):
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(LONDON).date().isoformat()


def extract_headcode_from_trust_train_id(train_id):
    if not train_id or len(train_id) < 6:
        return None
    return train_id[2:6].strip() or None


def normalise_records(payload):
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        return [payload]
    return []


def get_schedule_locations(schedule):
    segment = schedule.get("schedule_segment")
    if isinstance(segment, list):
        locations = []
        for item in segment:
            locations.extend(item.get("schedule_location") or [])
        return locations
    return (segment or {}).get("schedule_location") or []


def get_vstp_tiploc(location):
    return (
        (((location.get("location") or {}).get("tiploc") or {}).get("tiploc_id"))
        or location.get("tiploc_code")
        or location.get("tiploc_id")
    )


def get_location_tiploc(location, vstp=False):
    return get_vstp_tiploc(location) if vstp else location.get("tiploc_code")


def get_location_time(location, vstp=False):
    fields = (
        (
            "scheduled_pass_time",
            "pass",
            "scheduled_arrival_time",
            "arrival",
            "scheduled_departure_time",
            "departure",
        )
        if vstp
        else ("pass", "arrival", "departure")
    )
    return first_present(*(location.get(field) for field in fields))


def parse_local_rail_time(value):
    if value in (None, ""):
        return None

    cleaned = str(value).strip().upper()
    half_minute = cleaned.endswith("H")
    if half_minute:
        cleaned = cleaned[:-1]

    if not cleaned.isdigit() or len(cleaned) not in (3, 4, 5, 6):
        return None

    if len(cleaned) in (3, 5):
        cleaned = f"0{cleaned}"

    hours = int(cleaned[:2])
    minutes = int(cleaned[2:4])
    seconds = int(cleaned[4:6]) if len(cleaned) == 6 else 30 if half_minute else 0

    if hours > 23 or minutes > 59 or seconds > 59:
        return None
    return hours * 3600 + minutes * 60 + seconds


def find_target_location(locations, target_tiploc, vstp=False):
    previous_seconds = None
    day_offset = 0

    for location in locations:
        tiploc = get_location_tiploc(location, vstp=vstp)
        seconds = parse_local_rail_time(get_location_time(location, vstp=vstp))

        if (
            seconds is not None
            and previous_seconds is not None
            and seconds < previous_seconds - 12 * 3600
        ):
            day_offset += 1

        if seconds is not None:
            previous_seconds = seconds

        if tiploc == target_tiploc and seconds is not None:
            return {
                "seconds_after_midnight": seconds,
                "day_offset": day_offset,
                "direction_ind": infer_direction(location),
                "line": first_present(location.get("line"), location.get("CIF_line")),
                "path": first_present(location.get("path"), location.get("CIF_path")),
            }

    return None


def get_route_endpoints(locations, vstp=False):
    tiplocs = [
        get_location_tiploc(location, vstp=vstp)
        for location in locations
    ]
    tiplocs = [value for value in tiplocs if value]
    return {
        "origin_tiploc": tiplocs[0] if tiplocs else None,
        "destination_tiploc": tiplocs[-1] if tiplocs else None,
    }


def expand_run_dates(schedule, lookahead_days, base_date=None):
    base_date = base_date or datetime.now(LONDON).date()
    result = []
    for offset in range(lookahead_days):
        candidate = base_date + timedelta(days=offset)
        if runs_on_date(schedule, candidate):
            result.append(candidate.isoformat())
    return result


def runs_on_date(schedule, candidate):
    start = schedule.get("schedule_start_date")
    end = schedule.get("schedule_end_date")
    candidate_text = candidate.isoformat()
    if start and candidate_text < start:
        return False
    if end and candidate_text > end:
        return False

    days = schedule.get("schedule_days_runs")
    if not days or len(days) != 7:
        return True
    return days[candidate.weekday()] == "1"


def schedule_datetime(service_date, seconds_after_midnight, day_offset=0):
    local_date = date.fromisoformat(service_date) + timedelta(days=day_offset)
    local_value = datetime.combine(local_date, datetime.min.time()).replace(
        tzinfo=LONDON
    ) + timedelta(seconds=seconds_after_midnight)
    return local_value.astimezone(timezone.utc).replace(tzinfo=None)


def normalise_direction(value):
    if not value:
        return None
    cleaned = str(value).strip().upper()
    if cleaned == "UP" or cleaned.startswith("U"):
        return "UP"
    if cleaned == "DOWN" or cleaned.startswith("D"):
        return "DOWN"
    return cleaned or None


def infer_direction(location):
    return normalise_direction(
        first_present(
            location.get("direction_ind"),
            location.get("direction"),
            location.get("line"),
            location.get("CIF_line"),
            location.get("path"),
            location.get("CIF_path"),
        )
    )


def first_present(*values):
    for value in values:
        if value is not None and str(value).strip() != "":
            return value
    return None

# Arksey Level Crossing Schema

This repository contains a PostgreSQL schema for driving a live page that reports
whether Arksey level crossing is open or closed using OpenRailData / Network Rail
feed data for TIPLOC `ARKSEYL`.

The rule implemented in `schema.sql` is:

- `Crossing Closed` from 3 minutes before a train passes `ARKSEYL`.
- `Crossing Closed` until 1 minute after that train passes.
- If train windows overlap or touch, the merged window stays closed until the
  final train's window has ended.
- Otherwise the page reports `Crossing Open`.

## Files

- `schema.sql` creates the tables, indexes, seed data, and views.
- `src/` contains the OpenRailData ingestion service.
- `v_crossing_page_payload` is the frontend-facing view. Query it by
  `crossing_slug = 'arksey'`.

## Feed Mapping

Use planned and amended schedule feeds to create forward-looking passage rows:

- `network_rail_schedule`: base planned services and location pass times.
- `network_rail_vstp`: short-notice services due to run in the next 48 hours.
- `network_rail_train_movements`: actual movement reports. Use these to set
  `actual_pass_at`, cancel/delete services, and improve the post-passage state.

The schema keeps the raw message in `rail_feed_message.payload` and writes the
normalised crossing-relevant event into `train_passage`.

OpenRailData references:

- [SCHEDULE feed](https://wiki.openraildata.com/index.php/SCHEDULE)
- [CIF schedule records](https://wiki.openraildata.com/index.php/CIF_Schedule_Records)
- [CIF location records](https://wiki.openraildata.com/index.php/CIF_Location)
- [VSTP feed](https://wiki.openraildata.com/index.php/VSTP)
- [Train Movements feed](https://wiki.openraildata.com/index.php/Train_Movements)
- [Train Movement messages](https://wiki.openraildata.com/index.php/Train_Movement)

## Frontend Query

```sql
SELECT payload
FROM v_crossing_page_payload
WHERE crossing_slug = 'arksey';
```

Example payload:

```json
{
  "crossing": "Arksey Level Crossing",
  "tiploc": "ARKSEYL",
  "isClosed": true,
  "status": "Crossing Closed",
  "closedFrom": "2026-06-17T14:57:00+01:00",
  "opensAt": "2026-06-17T15:04:00+01:00",
  "trainsInCurrentWindow": 2,
  "currentTrainPassageIds": [123, 124],
  "nextClosesAt": "2026-06-17T15:18:00+01:00",
  "nextOpensAt": "2026-06-17T15:22:00+01:00",
  "nextTrainCount": 1,
  "overrideReason": null,
  "calculatedAt": "2026-06-17T15:00:12+01:00"
}
```

## Import Pattern

1. Insert each inbound feed message into `rail_feed_message`.
2. Resolve the service identity into `train_service`.
3. Upsert any schedule, VSTP, forecast, or movement time for `ARKSEYL` into
   `train_passage`.
4. Poll `v_crossing_page_payload` from the page, or publish it through a small
   API/WebSocket layer whenever relevant `train_passage` rows change.

## OpenRailData Ingestor

Install dependencies:

```powershell
pnpm install
```

Create `.env` from `.env.example` and fill in:

- `DATABASE_URL`
- `OPENRAIL_USERNAME`
- `OPENRAIL_PASSWORD`
- `TARGET_STANOX`, unless the daily timetable import has already populated
  `tiploc_location.stanox` for `ARKSEYL`

Apply the schema:

```powershell
psql "$env:DATABASE_URL" -f schema.sql
```

Run a one-off timetable import:

```powershell
pnpm run import:schedule
```

Run the live service:

```powershell
pnpm start
```

The service subscribes to:

- `/topic/TRAIN_MVT_ALL_TOC` for TRUST movement updates.
- `/topic/VSTP_ALL` for very short term planning schedules.

It also schedules a daily JSON SCHEDULE import at `SCHEDULE_DAILY_TIME`
(`06:15 Europe/London` by default). The JSON SCHEDULE full extract is used by
default because it is a simple daily snapshot. You can switch to update extracts
with `SCHEDULE_TYPE=CIF_ALL_UPDATE_DAILY` and the appropriate `SCHEDULE_DAY`
value if you want sequential update-file processing.

Train Movement messages use STANOX, not TIPLOC. The importer stores matching
TIPLOC reference records from the SCHEDULE file, but if `ARKSEYL` does not get a
STANOX that way, set `TARGET_STANOX` manually.

Sample passage insert:

```sql
INSERT INTO train_service (train_uid, service_date, headcode)
VALUES ('C12345', '2026-06-17', '1A23')
ON CONFLICT (train_uid, service_date) WHERE train_uid IS NOT NULL
DO UPDATE SET headcode = EXCLUDED.headcode
RETURNING id;

INSERT INTO train_passage (
  service_id,
  tiploc_code,
  scheduled_pass_at,
  estimated_pass_at,
  confidence
)
VALUES (
  1,
  'ARKSEYL',
  '2026-06-17 15:00:00 Europe/London',
  '2026-06-17 15:02:00 Europe/London',
  'estimated'
);
```

## Operational Notes

Store times as `timestamptz`; render them as `Europe/London` on the page.

The Train Movements feed is actual/confirming data, not enough by itself to say
the crossing will close three minutes before the train. For the forward-looking
closed state, import SCHEDULE and VSTP pass times, then update them as better
predictions or actual movement events arrive.

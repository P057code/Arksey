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

Run the web page:

```powershell
pnpm run web
```

Then open:

```text
http://localhost:3000
```

The page polls `/api/status` and displays:

- current crossing state from `v_crossing_state`
- next train in each available direction from `v_crossing_next_train`
- timetabled passing time
- live/actual passing time when VSTP or TRUST movement data has updated it
- the upcoming ARKSEYL train list

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

## Live Webserver Setup

The live deployment needs three pieces running:

- PostgreSQL for the schema and live train/crossing state.
- The ingestor process, `pnpm start`, for STOMP feeds and daily timetable import.
- The web process, `pnpm run web`, for the public page and `/api/status`.

These examples assume an Ubuntu/Debian server, Nginx, and systemd. Adapt paths
and usernames if your host uses a different layout.

### 1. Server Packages

```bash
sudo apt update
sudo apt install -y git postgresql nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo corepack enable
sudo corepack prepare pnpm@latest --activate
```

Create a deployment user:

```bash
sudo adduser --system --group --home /opt/arksey arksey
```

Clone or copy the app:

```bash
sudo -u arksey git clone <your-repo-url> /opt/arksey/app
cd /opt/arksey/app
sudo -u arksey pnpm install --prod
```

### 2. PostgreSQL

Create the database and user:

```bash
sudo -u postgres psql
```

```sql
CREATE USER arksey WITH PASSWORD 'replace-with-a-strong-password';
CREATE DATABASE arksey OWNER arksey;
\q
```

Apply the schema:

```bash
cd /opt/arksey/app
export DATABASE_URL='postgres://arksey:replace-with-a-strong-password@localhost:5432/arksey'
psql "$DATABASE_URL" -f schema.sql
```

### 3. Environment File

Create `/opt/arksey/app/.env` and keep it readable only by the deployment user:

```bash
sudo -u arksey cp /opt/arksey/app/.env.example /opt/arksey/app/.env
sudo chmod 600 /opt/arksey/app/.env
```

Set these values:

```dotenv
DATABASE_URL=postgres://arksey:replace-with-a-strong-password@localhost:5432/arksey
PORT=3000
OPENRAIL_USERNAME=your-network-rail-login@example.com
OPENRAIL_PASSWORD=your-network-rail-password
TARGET_TIPLOC=ARKSEYL
TARGET_STANOX=
OPENRAIL_STOMP_HOST=publicdatafeeds.networkrail.co.uk
OPENRAIL_STOMP_PORT=61618
OPENRAIL_STOMP_TOPICS=TRAIN_MVT_ALL_TOC,VSTP_ALL
OPENRAIL_STOMP_CLIENT_ID=arksey-level-crossing
OPENRAIL_STOMP_DURABLE=true
SCHEDULE_DAILY_TIME=06:15
SCHEDULE_TIMEZONE=Europe/London
SCHEDULE_LOOKAHEAD_DAYS=3
SCHEDULE_TYPE=CIF_ALL_FULL_DAILY
SCHEDULE_DAY=toc-full
SCHEDULE_IMPORT_ON_START=true
```

Do not commit `.env`. It contains database and OpenRailData credentials.

### 4. Initial Import And Connection Test

Run the schedule import once:

```bash
cd /opt/arksey/app
sudo -u arksey pnpm run import:schedule
```

Start the web process manually for a quick check:

```bash
sudo -u arksey pnpm run web
```

In another shell:

```bash
curl http://127.0.0.1:3000/api/status
```

Stop the manual process before installing systemd services.

### 5. systemd Services

Create `/etc/systemd/system/arksey-ingest.service`:

```ini
[Unit]
Description=Arksey OpenRailData ingestor
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=arksey
Group=arksey
WorkingDirectory=/opt/arksey/app
EnvironmentFile=/opt/arksey/app/.env
ExecStart=/usr/bin/pnpm start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Create `/etc/systemd/system/arksey-web.service`:

```ini
[Unit]
Description=Arksey crossing web page
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=arksey
Group=arksey
WorkingDirectory=/opt/arksey/app
EnvironmentFile=/opt/arksey/app/.env
ExecStart=/usr/bin/pnpm run web
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start both:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now arksey-ingest arksey-web
sudo systemctl status arksey-ingest
sudo systemctl status arksey-web
```

Useful logs:

```bash
sudo journalctl -u arksey-ingest -f
sudo journalctl -u arksey-web -f
```

### 6. Nginx Reverse Proxy

Create `/etc/nginx/sites-available/arksey`:

```nginx
server {
    listen 80;
    server_name your-domain.example;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable it:

```bash
sudo ln -s /etc/nginx/sites-available/arksey /etc/nginx/sites-enabled/arksey
sudo nginx -t
sudo systemctl reload nginx
```

Add HTTPS with Certbot:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.example
```

Only ports `80` and `443` need to be public. Keep Postgres private to the
server, and do not expose `PORT=3000` directly to the internet. The server also
needs outbound access to `publicdatafeeds.networkrail.co.uk:61618` for STOMP and
outbound HTTPS for the daily SCHEDULE download.

### 7. Updating The Live Site

```bash
cd /opt/arksey/app
sudo -u arksey git pull
sudo -u arksey pnpm install --prod
export DATABASE_URL='postgres://arksey:replace-with-a-strong-password@localhost:5432/arksey'
psql "$DATABASE_URL" -f schema.sql
sudo systemctl restart arksey-ingest arksey-web
```

Check the public page and `/api/status` after every deploy.

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

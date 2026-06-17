# Hosted Apache / Krystal Setup

This guide is for running the Arksey crossing webpage on a hosted Linux/Apache
account such as Krystal cPanel hosting.

Krystal's cPanel hosting can run Node.js applications through the cPanel
`Setup Node.js App` feature, which sits behind the web server. That is suitable
for the public webpage and `/api/status`.

The continuous OpenRailData STOMP ingestor is different: it is a long-running
background process that needs to stay connected to
`publicdatafeeds.networkrail.co.uk:61618`. On shared/cPanel hosting, this may
not be reliable or allowed as a background worker. The recommended production
layout is:

- Krystal cPanel/Apache: public webpage and API.
- External PostgreSQL database: stores timetable, movement, and crossing state.
- VPS/background worker: runs the STOMP ingestor and daily timetable import.

References:

- [Krystal Node.js App setup guide](https://help.krystal.io/nodejs/node-js-app-setup-guide)
- [Krystal cPanel advanced topics / SSH](https://help.krystal.io/cpanel-advanced-topics)

## What You Need

- Krystal cPanel hosting with `Setup Node.js App` available.
- SSH access enabled for the cPanel account.
- A PostgreSQL database reachable from both Krystal and the ingestor host.
- OpenRailData / Network Rail Data Feeds credentials.
- A separate always-on host for the ingestor, unless your hosting plan explicitly
  supports persistent background Node processes.

This project uses PostgreSQL-specific SQL. A standard cPanel MySQL database will
not work without rewriting the schema and queries.

## Recommended Architecture

```text
Public visitor
  |
  v
Krystal Apache / cPanel Node.js app
  |
  v
External PostgreSQL database
  ^
  |
VPS/background worker running OpenRailData STOMP + daily SCHEDULE import
```

The webpage does not connect to OpenRailData directly. It only reads the latest
state from PostgreSQL through `/api/status`.

## 1. Prepare PostgreSQL

Use an external PostgreSQL provider or a VPS-hosted PostgreSQL instance. Create a
database and user, then apply the schema from your local machine or from SSH:

```bash
psql "postgres://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require" -f schema.sql
```

Use `sslmode=require` if your database provider requires TLS.

Keep the final database URL ready:

```text
postgres://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require
```

## 2. Upload The Project To Krystal

Use Git over SSH if available:

```bash
cd ~
git clone <your-repo-url> arksey
cd arksey
```

Or upload the project through cPanel File Manager/SFTP into a folder such as:

```text
/home/CPANEL_USERNAME/arksey
```

Do not upload your local `.env` if it contains real credentials unless you are
intentionally deploying those exact production values.

## 3. Create The Node.js App In cPanel

In Krystal cPanel:

1. Open **Setup Node.js App**.
2. Click **Create Application**.
3. Choose a Node.js version. Use the newest available LTS version.
4. Set **Application mode** to `production`.
5. Set **Application root** to the project folder, for example:

```text
arksey
```

6. Set **Application URL** to the domain or subdomain you want to use, for
   example:

```text
https://crossing.example.co.uk
```

7. Set **Application startup file** to:

```text
src/webServer.js
```

8. Save the app, but do not start it yet.

Krystal's guide shows the same general cPanel flow for creating the Node app,
entering the app's virtual shell, installing dependencies, and setting the
startup file.

## 4. Install Dependencies In The Node Environment

From the cPanel Node.js app screen, copy the activation command. It will look
similar to this:

```bash
source /home/CPANEL_USERNAME/nodevenv/arksey/22/bin/activate && cd /home/CPANEL_USERNAME/arksey
```

Run it over SSH, then install dependencies:

```bash
npm install
```

If `pnpm` is available in your Krystal environment, this also works:

```bash
corepack enable
pnpm install --prod
```

If `corepack` is unavailable on the shared host, use `npm install`. The committed
`package.json` is enough for npm to install `pg` and `stompit`.

## 5. Configure Environment Variables

Use the cPanel Node.js app environment variable UI if available, or create
`/home/CPANEL_USERNAME/arksey/.env`.

Minimum variables for the web app:

```dotenv
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require
PORT=3000
TARGET_TIPLOC=ARKSEYL
```

Do not put OpenRailData credentials in the Krystal web app unless you are also
running the ingestor there. The webpage only needs `DATABASE_URL`.

If using a `.env` file:

```bash
chmod 600 /home/CPANEL_USERNAME/arksey/.env
```

## 6. Start The Web App

Return to **Setup Node.js App** in cPanel and click **Start App**.

Open the public URL you selected. For a quick browser-only demo that does not
touch the database, open:

```text
https://your-domain.example/?demo=1
```

Then check the real API:

```text
https://your-domain.example/api/status
```

If the API returns a database error, check:

- `DATABASE_URL` is correct.
- The external PostgreSQL host allows inbound connections from Krystal.
- SSL mode is correct for the database provider.
- `schema.sql` has been applied.

## 7. Run The Ingestor Elsewhere

Run the ingestor on a VPS, home server, or other service that supports persistent
background processes.

Clone the same project on that host, install dependencies, create `.env`, and
point `DATABASE_URL` to the same external PostgreSQL database used by the Krystal
web app:

```dotenv
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require
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

Run the initial timetable import:

```bash
npm run import:schedule
```

Run the ingestor:

```bash
npm start
```

For a VPS, use `systemd` so it restarts automatically:

```ini
[Unit]
Description=Arksey OpenRailData ingestor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/arksey/app
EnvironmentFile=/opt/arksey/app/.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

## 8. Optional: Daily Timetable Via Cron

If you cannot run the always-on STOMP ingestor, you can still run a degraded
timetable-only site by importing the schedule daily with cPanel Cron Jobs:

```bash
cd /home/CPANEL_USERNAME/arksey && /home/CPANEL_USERNAME/nodevenv/arksey/22/bin/npm run import:schedule
```

This gives planned train times only. It will not provide continuous live TRUST
movement updates, so live/actual times and last-minute changes may be missing.

## 9. Apache Notes

On Krystal cPanel hosting you normally do not edit Apache virtual hosts directly.
cPanel/Passenger wires the selected Application URL to your Node.js app.

If you are on a VPS with Apache root access instead of shared cPanel hosting,
use Apache as a reverse proxy:

```apache
<VirtualHost *:80>
    ServerName crossing.example.co.uk

    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:3000/
    ProxyPassReverse / http://127.0.0.1:3000/

    ErrorLog ${APACHE_LOG_DIR}/arksey-error.log
    CustomLog ${APACHE_LOG_DIR}/arksey-access.log combined
</VirtualHost>
```

Enable the modules and site:

```bash
sudo a2enmod proxy proxy_http headers
sudo a2ensite arksey
sudo apachectl configtest
sudo systemctl reload apache2
```

Add HTTPS with Certbot:

```bash
sudo apt install certbot python3-certbot-apache
sudo certbot --apache -d crossing.example.co.uk
```

## 10. Troubleshooting

- **Page loads but shows no data:** run `npm run import:schedule` on the ingestor
  host and check that `v_crossing_state` returns a row.
- **Database connection fails on Krystal:** confirm your database allows
  connections from the Krystal server IP and that `sslmode=require` is present
  when needed.
- **No live times:** the STOMP ingestor is not running, not authenticated, or
  cannot reach outbound TCP port `61618`.
- **Only TIPLOC codes show for origin/destination:** run the daily SCHEDULE full
  import so TIPLOC reference records populate `tiploc_location.display_name`.
- **cPanel app starts then stops:** check the Node.js app logs in cPanel and make
  sure the startup file is `src/webServer.js`, not `src/index.js`.

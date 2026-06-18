# Arksey Crossing - Python Edition

This is a standalone Python version of the Arksey level crossing application.
It sits alongside the Node.js project and uses the same MySQL 8 schema and
OpenRailData feeds.

It includes:

- Flask webpage and `/api/status` endpoint.
- MySQL storage.
- Daily Network Rail SCHEDULE JSON import.
- OpenRailData STOMP subscriptions for `TRAIN_MVT_ALL_TOC` and `VSTP_ALL`.
- Next train in each direction with timetable and live/actual times.
- Origin and destination labels.
- Crossing Open/Closed calculation.
- A top-right Light/Dark mode button that remembers the visitor's choice.

## Project Layout

```text
python-app/
  app.py                    Local Flask entrypoint
  passenger_wsgi.py         Krystal/cPanel Passenger entrypoint
  import_schedule.py        One-off daily timetable import
  run_ingestor.py           Long-running STOMP and schedule worker
  requirements.txt
  schema.sql                MySQL 8 schema
  arksey/                   Application modules
  templates/                Flask HTML templates
  static/                   CSS and browser JavaScript
```

## Requirements

- Python 3.10 or newer.
- MySQL 8.0 or a compatible MariaDB release with window functions and CTEs.
- OpenRailData / Network Rail Data Feeds account.

## Local Installation

From the `python-app` directory:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
Copy-Item .env.example .env
```

Edit `.env`:

```dotenv
DATABASE_URL=mysql://arksey:password@localhost:3306/arksey
PORT=5000
OPENRAIL_USERNAME=your-login@example.com
OPENRAIL_PASSWORD=your-password
TARGET_TIPLOC=ARKSEYL
```

Create the database and apply the schema:

```powershell
mysql -u root -p -e "CREATE DATABASE arksey CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -p arksey < schema.sql
```

Import the timetable:

```powershell
python import_schedule.py
```

Run the web app:

```powershell
python app.py
```

Open:

```text
http://127.0.0.1:5000
```

The page can be previewed without a database using:

```text
http://127.0.0.1:5000/?demo=1
```

Run the live worker separately:

```powershell
python run_ingestor.py
```

## Krystal.uk Shared Hosting Installation

Krystal supports Flask applications through cPanel's **Setup Python App**
feature. Their documentation notes that cPanel Python support is limited and
recommends a VPS for production Python applications, particularly for persistent
background processes.

Official references:

- [Krystal Flask setup guide](https://help.krystal.io/python/creating-a-python-app-using-the-flask-framework)
- [Krystal Python apps](https://help.krystal.io/python/python-apps)
- [Krystal cron jobs](https://help.krystal.io/cpanel/setting-up-cron-jobs)

### 1. Create The MySQL Database

In cPanel:

1. Open **MySQL Databases**.
2. Create a database, for example `CPANELUSER_arksey`.
3. Create a database user, for example `CPANELUSER_arkseyuser`.
4. Add the user to the database with **All Privileges**.

Database names and usernames are normally prefixed with the cPanel account
username.

Upload `schema.sql`, then use cPanel Terminal or SSH:

```bash
cd /home/CPANELUSER/arksey-python
mysql -h localhost -u CPANELUSER_arkseyuser -p CPANELUSER_arksey < schema.sql
```

### 2. Upload The Python Project

Upload the contents of `python-app` to:

```text
/home/CPANELUSER/arksey-python
```

Use Git, SFTP, or cPanel File Manager. Do not place the application inside
`public_html`; cPanel maps the Application URL to the project through
Passenger.

### 3. Create The Python Application

In cPanel:

1. Open **Setup Python App**.
2. Select **Create Application**.
3. Choose the newest available Python 3 version.
4. Set **Application root** to:

```text
arksey-python
```

5. Select the domain or subdomain for **Application URL**.
6. Set **Application startup file** to:

```text
passenger_wsgi.py
```

7. Set **Application Entry Point** to:

```text
application
```

8. Create the application.

Krystal may use LiteSpeed rather than stock Apache, but cPanel's Python
application/Passenger layer handles the routing. You do not need to edit an
Apache virtual host on shared hosting.

### 4. Install Python Packages

The cPanel application page shows a command for activating the virtual
environment. It will resemble:

```bash
source /home/CPANELUSER/virtualenv/arksey-python/3.11/bin/activate
cd /home/CPANELUSER/arksey-python
```

Run that command over SSH or cPanel Terminal, then:

```bash
python -m pip install --upgrade pip
pip install -r requirements.txt
```

Some cPanel versions also provide a **Run Pip Install** button. Select
`requirements.txt` when prompted.

### 5. Add Environment Variables

Use the environment variable section in **Setup Python App**, or create a
`.env` file in `/home/CPANELUSER/arksey-python`.

For the webpage:

```dotenv
DATABASE_URL=mysql://CPANELUSER_arkseyuser:MYSQL_PASSWORD@localhost:3306/CPANELUSER_arksey
PORT=5000
FLASK_DEBUG=false
TARGET_TIPLOC=ARKSEYL
```

If using `.env`:

```bash
chmod 600 /home/CPANELUSER/arksey-python/.env
```

If the MySQL password contains `@`, `:`, `/`, `#`, or other URL-reserved
characters, URL-encode it before placing it in `DATABASE_URL`.

### 6. Restart And Test

Return to **Setup Python App** and click **Restart**.

Test:

```text
https://your-domain.example/health
https://your-domain.example/?demo=1
https://your-domain.example/api/status
```

Expected health response:

```json
{"ok": true}
```

The demo URL verifies the Flask page and Light/Dark theme without requiring
database data.

### 7. Daily Timetable Import With Cron

Add the OpenRailData variables to `.env`:

```dotenv
OPENRAIL_USERNAME=your-login@example.com
OPENRAIL_PASSWORD=your-password
SCHEDULE_TYPE=CIF_ALL_FULL_DAILY
SCHEDULE_DAY=toc-full
SCHEDULE_LOOKAHEAD_DAYS=3
```

Run an initial import over SSH:

```bash
source /home/CPANELUSER/virtualenv/arksey-python/3.11/bin/activate
cd /home/CPANELUSER/arksey-python
python import_schedule.py
```

In cPanel **Cron Jobs**, schedule the import after the daily JSON file is
available, for example at 06:15:

```cron
15 6 * * * /home/CPANELUSER/virtualenv/arksey-python/3.11/bin/python /home/CPANELUSER/arksey-python/import_schedule.py >> /home/CPANELUSER/arksey-python/schedule-import.log 2>&1
```

Use the actual Python version path displayed by cPanel.

### 8. Live STOMP Worker

`run_ingestor.py` must remain connected to Network Rail's STOMP server. Shared
hosting may terminate long-running shell processes, so do not assume it will
stay alive on Krystal cPanel.

Recommended options:

1. Run `run_ingestor.py` on a small VPS.
2. Use a Krystal VPS rather than shared hosting.
3. Ask Krystal whether your plan permits persistent Python background workers
   and outbound TCP connections to port `61618`.

The VPS worker and Krystal webpage must use the same MySQL database.

If the worker is outside Krystal, the database must permit remote access from
that worker. Krystal documents SSH tunnelling for MySQL; a direct public MySQL
connection is not recommended because port `3306` traffic is normally
unencrypted.

On a VPS, a systemd service can keep the worker alive:

```ini
[Unit]
Description=Arksey Python OpenRailData worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=arksey
WorkingDirectory=/opt/arksey/python-app
EnvironmentFile=/opt/arksey/python-app/.env
ExecStart=/opt/arksey/python-app/.venv/bin/python run_ingestor.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now arksey-python-worker
```

## Updating On Krystal

Upload or pull the new files, activate the cPanel virtual environment, then:

```bash
cd /home/CPANELUSER/arksey-python
pip install -r requirements.txt
mysql -h localhost -u CPANELUSER_arkseyuser -p CPANELUSER_arksey < schema.sql
```

Restart the application from **Setup Python App**.

## Troubleshooting

- **Application will not start:** check the Passenger log and confirm the startup
  file is `passenger_wsgi.py` with entry point `application`.
- **No module named Flask/PyMySQL:** activate the exact cPanel virtual
  environment and rerun `pip install -r requirements.txt`.
- **API returns 500:** verify `DATABASE_URL`, MySQL privileges, and that
  `schema.sql` was applied.
- **Page works only with `?demo=1`:** the Flask app is running, but the database
  is unavailable or has no imported timetable.
- **No live times:** the STOMP worker is not running or cannot reach
  `publicdatafeeds.networkrail.co.uk:61618`.
- **Origins show TIPLOC codes:** run the full daily timetable import so TIPLOC
  reference names are loaded.

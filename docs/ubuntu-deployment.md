# Ubuntu self-hosted deployment

These templates run the Telegram bot continuously and run the four monitoring/sync jobs every ten minutes. They assume a dedicated `canvasguardian` account, a checkout at `/opt/canvas-guardian`, Node.js 24 and npm at `/usr/bin`, and a private environment file at `/etc/canvas-guardian/guardian.env`. Adjust the unit paths and user before installing if your layout differs. Use only one bot instance for a given Telegram token: two polling processes will compete for updates.

1. Install Node.js 24 and npm, then confirm `node --version` starts with `v24` and `command -v npm` matches the unit's `ExecStart`. As the service user, check out the reviewed commit and run `npm ci` and `npm test` in `/opt/canvas-guardian`.
2. Create `/etc/canvas-guardian/guardian.env` with the variables from [`.env.example`](../.env.example). Required for the bot and monitors: `CANVAS_BASE_URL`, `CANVAS_ACCESS_TOKEN`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_ALLOWED_CHAT_ID`. `TELEGRAM_REPORT_MAX_CSV_MIB` is optional; it defaults to 5 and accepts 1–20. `GOOGLE_CALENDAR_ID` and files under `secrets/` are needed only for the calendar job. Use simple `KEY=value` lines compatible with systemd `EnvironmentFile=`; quote values containing spaces. Protect the file with owner `root`, group `canvasguardian`, and mode `0640`.
3. Ensure `canvasguardian` owns and can write `/opt/canvas-guardian/data/` and its SQLite database and journal files (`horus.db*`). Keep the checkout and `secrets/` readable only by the service account as appropriate. Do not place private attendance exports in the repository checkout unless running the standalone CLI; Telegram uploads and reports stay in memory.
4. Copy the files in [`deploy/systemd/`](../deploy/systemd/) to `/etc/systemd/system/`, adjust paths, then run:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now canvas-guardian-telegram.service
   sudo systemctl enable --now canvas-guardian-job@activity.timer canvas-guardian-job@announcements.timer canvas-guardian-job@deadlines.timer
   # Enable only after Google Calendar credentials and token are configured:
   sudo systemctl enable --now canvas-guardian-job@calendar.timer
   ```

5. Verify startup and schedules with `systemctl status canvas-guardian-telegram.service`, `systemctl list-timers 'canvas-guardian-job@*'`, and `journalctl -u canvas-guardian-telegram.service -n 50 --no-pager`. Run a job once with `sudo systemctl start canvas-guardian-job@activity.service` and inspect it with `journalctl -u canvas-guardian-job@activity.service -n 50 --no-pager`. Send `/status` and `/report` in the authorized private chat; use a synthetic Roll Call CSV for a manual end-to-end report check.

The bot restarts after failure. Timers persist missed calendar ticks and each job runs as a one-shot service; systemd does not overlap instances of the same unit. After changing code or the environment file, run `sudo systemctl restart canvas-guardian-telegram.service`. Jobs use the new code on their next timer run; restart an active job only if needed. Read logs with `journalctl -u canvas-guardian-telegram.service -f` or `journalctl -u 'canvas-guardian-job@*.service' -n 100` and avoid posting log output if it contains private data.

For upgrades, record the current commit, stop the bot and timers, back up `data/horus.db*` and `secrets/` in a private location, then check out the reviewed commit, run `npm ci` and `npm test`, and start the units again. Check status, logs, and `/status`. If an upgrade fails, stop the units, return to the recorded commit, run `npm ci`, restore the SQLite backup if its schema was changed, and start the units. Do not overwrite a newer database backup during rollback. Telegram report generation does not modify the database schema.

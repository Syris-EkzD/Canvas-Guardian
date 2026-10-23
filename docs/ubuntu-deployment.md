# Ubuntu self-hosted deployment

These templates run the Telegram bot continuously and run the four monitoring/sync jobs every ten minutes. They assume a dedicated `canvasguardian` account, a checkout at `/opt/canvas-guardian`, Node.js 24 and npm at `/usr/bin`, and a private environment file at `/etc/canvas-guardian/guardian.env`. Adjust the unit paths and user before installing if your layout differs.

## Inventory before migration

Before enabling any new unit, identify what already runs on the host and record its unit names, schedules, working directories, environment-file paths, service user, and checkout commit. These read-only commands help locate system and user services, timers, and polling processes (substitute the actual service user where needed):

```bash
systemctl list-units --all --type=service --type=timer | grep -Ei 'canvas|guardian|horus|telegram'
systemctl list-unit-files --type=service --type=timer | grep -Ei 'canvas|guardian|horus|telegram'
systemctl list-timers --all
systemctl --user list-units --all --type=service --type=timer
ps -eo pid,user,args | grep -E '[t]elegram-bot|[g]uardian:telegram|[a]ctivity-monitor|[a]nnouncement-monitor|[d]eadline-monitor|[c]alendar-sync'
```

Also check `crontab -l`, the service user's crontab, `/etc/cron*`, and any process manager or container used on that host. For each candidate systemd unit, use `systemctl cat UNIT` and `systemctl show UNIT -p User -p WorkingDirectory -p EnvironmentFiles -p ExecStart` to confirm what it runs. Process arguments and unit definitions can contain secrets; inspect locally and redact them before sharing. Do not print environment-file contents into logs or review comments.

Only one process may poll a given Telegram bot token. Compare the existing bot's token source without copying or displaying the token, then stop and disable its service or process before starting `canvas-guardian-telegram.service`. Confirm the old polling process has exited with `systemctl status` and the process listing above. Likewise, stop and disable old activity, announcement, deadline, and Calendar timers or cron entries before enabling their replacement timers. Wait for any already running one-shot job to finish; a second schedule can duplicate notifications or Calendar updates. Keep the old unit files and schedule definitions for rollback.

Preserve the existing credential files and SQLite `data/horus.db*` state. Prefer pointing the new units at the existing protected environment file and working tree after checking path and syntax. If moving either, copy it privately while the old services are stopped, retain ownership and permissions, and verify the new service account can read credentials and write the database. Back up SQLite and `secrets/` before changing paths or code. Never start old and new bot instances against the same token, or old and new monitoring schedules against the same state, at the same time.

## Install and verify

1. Install Node.js 24 and npm, then confirm `node --version` starts with `v24` and `command -v npm` matches the unit's `ExecStart`. As the service user, check out the reviewed commit and run `npm ci` and `npm test` in `/opt/canvas-guardian`.
2. Reuse the existing protected environment file where practical, or create `/etc/canvas-guardian/guardian.env` with the variables from [`.env.example`](../.env.example). Required for the bot and monitors: `CANVAS_BASE_URL`, `CANVAS_ACCESS_TOKEN`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_ALLOWED_CHAT_ID`. `TELEGRAM_REPORT_MAX_CSV_MIB` is optional; it defaults to 5 and accepts 1–20. `GOOGLE_CALENDAR_ID` and files under `secrets/` are needed only for the calendar job. Use simple `KEY=value` lines compatible with systemd `EnvironmentFile=`; quote values containing spaces. Protect a new file with owner `root`, group `canvasguardian`, and mode `0640`; preserve the access controls of an existing file.
3. Ensure `canvasguardian` owns and can write `/opt/canvas-guardian/data/` and its SQLite database and journal files (`horus.db*`). Keep the checkout and `secrets/` readable only by the service account as appropriate. Do not place private attendance exports in the repository checkout unless running the standalone CLI; Telegram uploads and reports stay in memory.
4. After completing the inventory and disabling the old schedules, copy the files in [`deploy/systemd/`](../deploy/systemd/) to `/etc/systemd/system/`, adjust paths, then run:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now canvas-guardian-telegram.service
   sudo systemctl enable --now canvas-guardian-job@activity.timer canvas-guardian-job@announcements.timer canvas-guardian-job@deadlines.timer
   # Enable only after Google Calendar credentials and token are configured:
   sudo systemctl enable --now canvas-guardian-job@calendar.timer
   ```

5. Verify startup and schedules with `systemctl status canvas-guardian-telegram.service`, `systemctl list-timers 'canvas-guardian-job@*'`, and `journalctl -u canvas-guardian-telegram.service -n 50 --no-pager`. Run a job once with `sudo systemctl start canvas-guardian-job@activity.service` and inspect it with `journalctl -u canvas-guardian-job@activity.service -n 50 --no-pager`. Send `/status` and `/report` in the authorized private chat; use a synthetic Roll Call CSV for a manual end-to-end report check.

The bot restarts after failure. Timers persist missed calendar ticks and each job runs as a one-shot service; systemd does not overlap instances of the same unit. Separate old and new units can still overlap unless the old schedules are disabled first. After changing code or the environment file, run `sudo systemctl restart canvas-guardian-telegram.service`. Jobs use the new code on their next timer run; restart an active job only if needed. Read logs with `journalctl -u canvas-guardian-telegram.service -f` or `journalctl -u 'canvas-guardian-job@*.service' -n 100` and avoid posting log output if it contains private data.

The bot continues handling commands while one report is generated. A report upload is acknowledged when processing starts; if the bot process exits before delivery, the user must resend that CSV. The bot does not retain uploads or persist unfinished report work.

For upgrades, record the current commit, stop the bot and timers, back up `data/horus.db*` and `secrets/` in a private location, then check out the reviewed commit, run `npm ci` and `npm test`, and start the units again. Check status, logs, and `/status`. If a migration fails, stop and disable the new bot and timers before re-enabling the recorded old units and schedules. Return to the recorded commit and run `npm ci` if code was replaced. Restore the SQLite backup only if its schema was changed or state was damaged; otherwise keep the latest state, including Telegram's update offset. Do not overwrite a newer database backup during rollback. Telegram report generation does not modify the database schema.

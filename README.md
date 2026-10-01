# Canvas Guardian

Canvas Guardian is a self-hosted academic monitoring application designed to monitor Canvas LMS, send direct Telegram notifications, and synchronize assignment deadlines with Google Calendar.

It runs automatically on an Ubuntu server, so Canvas does not need to remain open in a browser.

## Features

- Monitors Canvas for new and upcoming activities
- Tracks unfinished and submitted assignments
- Sends activity and deadline alerts through Telegram
- Lists pending, daily, and weekly activities
- Retrieves recent Canvas announcements
- Synchronizes deadlines with Google Calendar
- Updates calendar events when deadlines change
- Removes calendar events after assignments are submitted
- Allows monitoring and calendar synchronization to be controlled through Telegram
- Runs automatically using systemd services and timers
- Prevents duplicate alerts and calendar events

## Telegram Commands

| Command | Description |
|---|---|
| `/start` | Start automatic Canvas monitoring |
| `/stop` | Stop automatic Canvas monitoring |
| `/pause` | Temporarily pause Canvas monitoring |
| `/resume` | Resume paused Canvas monitoring |
| `/status` | Show Canvas Guardian and calendar status |
| `/announcements` | Show recent Canvas announcements |
| `/pending` | Show all unfinished activities |
| `/today` | Show activities due today |
| `/week` | Show activities due within seven days |
| `/calendar on` | Enable calendar synchronization |
| `/calendar off` | Disable calendar synchronization |
| `/calendar status` | Show calendar synchronization status |
| `/help` | Show all available commands |

## How It Works

For assignment data, the main flow is:

```text
Canvas LMS
    ↓
src/canvas-client.js
    ↓
src/canvas-assignments.js
    ↓
Monitoring / Telegram / Calendar consumers
    ↓
SQLite / Telegram Bot HTTP API / Google Calendar
```

`src/canvas-client.js` centralizes authenticated Canvas REST API requests.
`canvasGet()` performs normal single-page GET requests, while `canvasGetAll()`
follows Canvas `rel="next"` pagination links and combines the returned pages.

`src/canvas-assignments.js` retrieves active courses and their assignments, then
normalizes assignment data into a reusable shape. Monitoring, Telegram queries,
deadline reminders, and manual pending checks retain single-page retrieval.
Google Calendar synchronization uses paginated retrieval. Each consumer keeps
its own published, pending, due-date, submitted, and excused filtering instead
of imposing one global filter in the shared assignment layer.

Monitoring state, notification history, and calendar mappings are stored in the
local SQLite database. Telegram notifications and commands use the Telegram Bot
HTTP API directly, and calendar synchronization creates, updates, or removes
Google Calendar events. The deployed personal instance uses systemd to schedule
and run these processes.

## Project Structure

```text
src/
  canvas-client.js
  canvas-assignments.js
  activity-monitor.js
  announcement-monitor.js
  deadline-monitor.js
  telegram-bot.js
  calendar-sync.js
  monitoring-state.js

test/
  canvas-client.test.js
  canvas-assignments.test.js

data/
secrets/
.github/workflows/ci.yml
.env.example
```

- `canvas-client.js` and `canvas-assignments.js` provide the shared Canvas data
  layer.
- The monitor, bot, and calendar files apply feature-specific behavior and send
  results to SQLite, Telegram, or Google Calendar.
- `monitoring-state.js` stores monitoring and calendar-sync settings in SQLite.
- `test/` contains deterministic tests for the shared Canvas data layer.
- `data/` and `secrets/` hold ignored local runtime data and private Google OAuth
  files; `.env.example` documents environment configuration.

## Technology

- Node.js
- Canvas LMS REST API
- Telegram Bot HTTP API through native Node `fetch`
- Google Calendar API
- SQLite through `better-sqlite3`
- Environment configuration through `dotenv`
- Node.js built-in test runner
- GitHub Actions
- systemd and Ubuntu Server for the deployed personal instance

## Local Setup

1. Clone the repository and enter it:

   ```bash
   git clone https://github.com/Syris-EkzD/Canvas-Guardian.git
   cd Canvas-Guardian
   ```

2. Install dependencies:

   ```bash
   npm ci
   ```

3. Copy the environment template and fill in the required values:

   ```bash
   cp .env.example .env
   ```

   Configure `CANVAS_BASE_URL`, `CANVAS_ACCESS_TOKEN`,
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_ID`, and
   `GOOGLE_CALENDAR_ID` in `.env`.

4. To use Google Calendar synchronization, provide these private files:

   - `secrets/google-oauth-credentials.json`
   - `secrets/google-oauth-token.json`

   After placing the Google Desktop app credentials file, the existing
   authorization script can create the OAuth token file:

   ```bash
   node src/authorize-google-calendar.js
   ```

5. Run the automated tests:

   ```bash
   npm test
   ```

Never commit `.env`, Canvas access tokens, Telegram bot tokens, Google OAuth
credential or token files, or local SQLite databases.

## Development and Testing

Run the automated tests with:

```bash
npm test
```

The suite uses Node.js's built-in test runner and deterministic mocked Canvas
HTTP responses, so it does not require live Canvas credentials or network
requests. Current coverage focuses on the shared Canvas HTTP and assignment-data
layers: URL and authorization behavior, Canvas HTTP errors, pagination,
assignment normalization, submission-state interpretation, and source ordering.
It does not cover Telegram, SQLite, Google Calendar integration, or complete
runtime behavior.

The GitHub Actions workflow runs `npm ci` followed by `npm test` on pushes to
`main` and pull requests targeting `main`. It performs dependency installation
and automated testing only; it does not deploy the application.

## Privacy and Security

Canvas Guardian uses read-only Canvas access and never automatically submits or modifies schoolwork.

API tokens, Google credentials, OAuth tokens, databases, and other private files are excluded from the Git repository through `.gitignore`.

## Project Status

Current stable version: `v0.2.0-calendar-stable`

That stable version includes automatic Canvas monitoring, Telegram commands,
and Google Calendar synchronization. Repository development may contain changes
that have not yet been included in a stable release.

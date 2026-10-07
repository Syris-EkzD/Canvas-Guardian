# Canvas Guardian

Canvas Guardian is a self-hosted academic companion for Canvas LMS. It now
contains two related areas that share the same Canvas access and assignment
normalization layer:

- **Guardian runtime** — monitors Canvas activity, sends Telegram notifications
  and commands, synchronizes assignment deadlines with Google Calendar, and
  keeps monitoring state in SQLite for a systemd-based self-hosted deployment.
- **Academic Data Pipeline** — combines live Canvas assignment data with
  official offline Roll Call CSV exports and generates a local Excel academic
  report.

## Guardian Runtime

The Guardian runtime includes:

- Canvas activity monitoring
- Telegram notifications and commands
- pending, today, and seven-day activity queries
- deadline reminders
- Canvas announcement monitoring and queries
- Google Calendar synchronization
- SQLite-backed monitoring and calendar state
- systemd-based self-hosted operation

## Academic Data Pipeline

The Academic Data Pipeline:

- fetches assignments from active Canvas courses through the shared Canvas
  client and assignment normalization layer
- identifies Roll Call from verified Instructure external-tool metadata rather
  than the assignment display name
- reads official Roll Call CSV exports from `data/input/attendance/*.csv`
- filters attendance to the authenticated Canvas user before normalization
- supports multiple attendance exports and multiple courses
- validates class dates and `present`, `absent`, and `late` statuses
- deduplicates overlapping attendance events by
  `courseId + sectionId + classDate`
- writes `data/output/academic-report.xlsx` with `Summary`, `Assignments`, and
  `Attendance` sheets

Missing attendance rows are never interpreted as Present or Absent. The
detailed academic pipeline flow is documented in
[`docs/academic-pipeline.md`](docs/academic-pipeline.md).

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

Canvas assignment data passes through one shared layer before the runtime and
academic pipeline apply their own feature-specific behavior:

~~~text
Canvas LMS
    ↓
src/canvas-client.js
    ↓
src/canvas-assignments.js
    ↓
shared normalized Canvas data
    ├── Guardian runtime consumers
    │   ├── monitoring
    │   ├── Telegram
    │   └── Google Calendar
    │
    └── Academic Data Pipeline
        ├── normal academic activities
        ├── Canvas Roll Call aggregate grade
        └── official offline Roll Call CSV attendance
                ↓
        data/output/academic-report.xlsx
~~~

`src/canvas-client.js` centralizes authenticated Canvas REST API requests.
`canvasGet()` handles normal single-page requests, while `canvasGetAll()`
follows Canvas `rel="next"` pagination links and rejects pagination URLs from
foreign origins before forwarding the Canvas access token.

`src/canvas-assignments.js` retrieves active courses and assignments, then
normalizes them into a reusable shape. Guardian consumers apply their own
published, pending, due-date, submitted, and excused filtering. Google Calendar
synchronization and the Academic Data Pipeline use paginated assignment
retrieval.

The Academic Data Pipeline combines those normalized Canvas assignments with
separate official Roll Call CSV exports. Canvas supplies the Roll Call aggregate
grade; detailed class-date attendance comes from the offline exports. See
[`docs/academic-pipeline.md`](docs/academic-pipeline.md) for the detailed flow.

## Project Structure

~~~text
src/
  canvas-client.js
  canvas-assignments.js

  attendance-import.js
  attendance-files.js
  academic-report.js
  run-academic-pipeline.js

  activity-logic.js
  activity-monitor.js
  announcement-monitor.js
  deadline-monitor.js
  telegram-client.js
  telegram-bot.js
  calendar-sync.js
  monitoring-state.js
  runtime-config.js

test/
  canvas-client.test.js
  canvas-assignments.test.js
  attendance-import.test.js
  attendance-files.test.js
  academic-report.test.js
  activity-logic.test.js
  deadline-monitor.test.js
  runtime-config.test.js
  runtime-import-safety.test.js
  telegram-client.test.js

docs/
  academic-pipeline.md
  releases/
    v0.3.0.md

CHANGELOG.md

data/
  input/
    attendance/
  output/

secrets/
.github/workflows/ci.yml
.env.example
~~~

- `canvas-client.js` and `canvas-assignments.js` provide the shared Canvas data
  layer.
- The Guardian monitor, bot, and calendar modules apply feature-specific
  behavior and use SQLite, Telegram, or Google Calendar as needed.
- `activity-logic.js`, `runtime-config.js`, and `telegram-client.js` keep shared
  runtime rules, startup validation, and Telegram HTTP behavior small and
  independently testable.
- The academic pipeline modules import, validate, normalize, deduplicate, and
  report Canvas and Roll Call data.
- `data/` and `secrets/` contain local runtime or private data that should not be
  committed.

## Technology

- Node.js
- Canvas LMS REST API
- Telegram Bot HTTP API through native `fetch`
- Google Calendar API
- SQLite through `better-sqlite3`
- `dotenv`
- `csv-parse`
- ExcelJS
- Node.js built-in test runner
- GitHub Actions
- systemd / Ubuntu Server

## Local Setup

1. Clone the repository and enter it:

   ~~~bash
   git clone https://github.com/Syris-EkzD/Canvas-Guardian.git
   cd Canvas-Guardian
   ~~~

2. Install dependencies:

   ~~~bash
   npm ci
   ~~~

3. Copy the environment template and fill in the required values:

   ~~~bash
   cp .env.example .env
   ~~~

   Configure only the values required by the features you use:

   - **Canvas access:** `CANVAS_BASE_URL` and `CANVAS_ACCESS_TOKEN` are
     required by Canvas-backed Guardian services and the Academic Data Pipeline.
   - **Telegram runtime:** `TELEGRAM_BOT_TOKEN` and
     `TELEGRAM_ALLOWED_CHAT_ID` are required by the Guardian notification
     monitors and Telegram command bot.
   - **Google Calendar:** `GOOGLE_CALENDAR_ID` is required only for Calendar
     synchronization.

4. To use Google Calendar synchronization, provide these private files:

   - `secrets/google-oauth-credentials.json`
   - `secrets/google-oauth-token.json`

   After placing the Google Desktop app credentials file, the existing
   authorization script can create the OAuth token file:

   ~~~bash
   node src/authorize-google-calendar.js
   ~~~

5. Run the automated tests:

   ~~~bash
   npm test
   ~~~

Never commit `.env`, Canvas access tokens, Telegram bot tokens, Google OAuth
credential or token files, or local SQLite databases.

### Guardian Runtime Commands

The supported executable Guardian services can be run directly through npm:

~~~bash
npm run guardian:activity
npm run guardian:announcements
npm run guardian:deadlines
npm run guardian:telegram
npm run guardian:calendar
~~~

These commands expose the existing runtime entry points without replacing the
systemd-based automated deployment used by the self-hosted instance.

### Academic Data Pipeline

1. Place one or more official Roll Call CSV exports in
   `data/input/attendance/`.
2. Ensure `.env` contains `CANVAS_BASE_URL` and `CANVAS_ACCESS_TOKEN`.
3. Run:

   ~~~bash
   npm run academic:pipeline
   ~~~

4. Open the generated report at
   `data/output/academic-report.xlsx`.

The `.env` file remains private. Attendance CSV exports and generated academic
reports are ignored by Git.

## Development and Testing

Run the deterministic test suite with:

~~~bash
npm test
~~~

The suite uses Node.js's built-in test runner with mocked Canvas HTTP responses,
temporary attendance files, and in-memory workbook checks. Current coverage
includes:

- authenticated Canvas requests and Canvas HTTP errors
- pagination and same-origin pagination protection
- assignment normalization and submitted/excused behavior
- Roll Call identification from external-tool metadata
- academic Summary logic and assignment percentage calculation
- Roll Call CSV parsing and current-user attendance filtering
- class-date and attendance-status validation
- multi-file attendance ingestion and attendance deduplication
- generated workbook schema
- Guardian pending/excused semantics and Manila date selection
- deterministic deadline reminder thresholds
- runtime configuration validation
- Telegram request construction and error handling
- runtime import safety without production secrets, service startup, external
  requests, or SQLite initialization

Runtime scripts keep startup-only initialization behind direct-execution guards,
so importing tested logic does not start services or open the production runtime
database.

This is deterministic unit/module coverage, not full integration or end-to-end
coverage. The automated suite does not require live Canvas credentials,
Telegram, Google Calendar, or real attendance exports.

The GitHub Actions workflow runs `npm ci` followed by `npm test` on pushes to
`main` and pull requests targeting `main`. It does not deploy the application.

## Privacy and Security

- Canvas credentials are isolated through `.env`; access tokens are not
  committed.
- Official attendance CSV exports and generated academic reports are ignored by
  Git.
- Roll Call exports are filtered to the authenticated Canvas user, and student
  IDs are not retained in normalized attendance records.
- Canvas pagination rejects foreign origins before authenticated follow-up
  requests are sent.
- Google OAuth credentials, tokens, and local SQLite databases remain excluded
  from the repository.

## Project Status

The source version is `0.3.0`, representing the current `v0.3.0` release
line. Git tags and GitHub Releases are publication artifacts managed separately
from the source version.

See [`CHANGELOG.md`](CHANGELOG.md) for the release history and
[`docs/releases/v0.3.0.md`](docs/releases/v0.3.0.md) for the v0.3.0 release
details.

The older `v0.2.0-calendar-stable` name remains a documented historical
milestone rather than an actual historical Git tag or GitHub Release artifact.

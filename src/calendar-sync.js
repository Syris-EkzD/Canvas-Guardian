require("dotenv").config({ quiet: true });

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { google } = require("googleapis");
const { canvasGetAll } = require("./canvas-client");
const {
  getMonitoringState,
  getCalendarSyncEnabled,
} = require("./monitoring-state");

const {
  GOOGLE_CALENDAR_ID,
} = process.env;

const projectRoot = path.join(__dirname, "..");

const credentialsPath = path.join(
  projectRoot,
  "secrets",
  "google-oauth-credentials.json"
);

const tokenPath = path.join(
  projectRoot,
  "secrets",
  "google-oauth-token.json"
);

const db = new Database(
  path.join(projectRoot, "data", "horus.db")
);

db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS google_calendar_events (
    assignment_key TEXT PRIMARY KEY,
    google_event_id TEXT NOT NULL,
    due_at TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    synced_at TEXT NOT NULL
  );
`);

function createGoogleCalendarClient() {
  const credentials = JSON.parse(
    fs.readFileSync(credentialsPath, "utf8")
  );

  const token = JSON.parse(
    fs.readFileSync(tokenPath, "utf8")
  );

  const client = credentials.installed;

  const auth = new google.auth.OAuth2(
    client.client_id,
    client.client_secret,
    client.redirect_uris?.[0]
  );

  auth.setCredentials(token);

  return google.calendar({
    version: "v3",
    auth,
  });
}

function isSubmitted(assignment) {
  const submission = assignment.submission;

  return (
    Boolean(submission?.submitted_at) ||
    submission?.workflow_state === "submitted" ||
    submission?.workflow_state === "graded"
  );
}

async function getDatedAssignments() {
  const courses = await canvasGetAll(
    "/api/v1/courses?enrollment_state=active&per_page=100"
  );

  const activities = [];

  for (const course of courses) {
    const assignments = await canvasGetAll(
      `/api/v1/courses/${course.id}/assignments?include[]=submission&order_by=due_at&per_page=100`
    );

    for (const assignment of assignments) {
      if (!assignment.published || !assignment.due_at) {
        continue;
      }

      activities.push({
        key: `${course.id}:${assignment.id}`,
        course: course.course_code || course.name,
        name: assignment.name,
        dueAt: assignment.due_at,
        htmlUrl: assignment.html_url,
        submitted: isSubmitted(assignment),
        excused: assignment.submission?.excused === true,
      });
    }
  }

  return activities.sort(
    (a, b) =>
      new Date(a.dueAt).getTime() -
      new Date(b.dueAt).getTime()
  );
}

function formatDate(dateString) {
  return new Date(dateString).toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function buildGoogleEvent(activity) {
  const end = new Date(activity.dueAt);
  const start = new Date(activity.dueAt);

  let status = "Not submitted";
  let icon = "📚";

  if (activity.submitted) {
    status = "Submitted";
    icon = "✅";
  } else if (activity.excused) {
    status = "Excused";
    icon = "☑️";
  }

  return {
    summary: `${icon} [${activity.course}] ${activity.name}`,
    description: [
      `Course: ${activity.course}`,
      `Status: ${status}`,
      `Due: ${formatDate(activity.dueAt)}`,
      "",
      activity.htmlUrl
        ? `Open in Canvas: ${activity.htmlUrl}`
        : "",
      "",
      "Managed automatically by Horus.",
    ].join("\n"),
    start: {
      dateTime: start.toISOString(),
      timeZone: "Asia/Manila",
    },
    end: {
      dateTime: end.toISOString(),
      timeZone: "Asia/Manila",
    },
    transparency: "transparent",
    reminders: {
      useDefault: false,
    },
    extendedProperties: {
      private: {
        managedBy: "horus",
        canvasAssignmentKey: activity.key,
      },
    },
  };
}

function createContentHash(event) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(event))
    .digest("hex");
}

async function main() {
  if (!GOOGLE_CALENDAR_ID) {
    throw new Error("GOOGLE_CALENDAR_ID is missing from .env");
  }

  const monitoringState = getMonitoringState(db);

  if (monitoringState !== "running") {
    console.log(
      `Horus is ${monitoringState}. Calendar sync skipped.`
    );

    return;
  }

  const calendarSyncEnabled = getCalendarSyncEnabled(db);

  if (!calendarSyncEnabled) {
    console.log(
      "Google Calendar synchronization is disabled. Sync skipped."
  );

  return;
}

  const calendar = createGoogleCalendarClient();
  const activities = await getDatedAssignments();
  const now = Date.now();

  const findMapping = db.prepare(`
    SELECT google_event_id, due_at, content_hash
    FROM google_calendar_events
    WHERE assignment_key = ?
  `);

  const saveMapping = db.prepare(`
    INSERT INTO google_calendar_events (
      assignment_key,
      google_event_id,
      due_at,
      content_hash,
      synced_at
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(assignment_key) DO UPDATE SET
      google_event_id = excluded.google_event_id,
      due_at = excluded.due_at,
      content_hash = excluded.content_hash,
      synced_at = excluded.synced_at
  `);

  const deleteMapping = db.prepare(`
    DELETE FROM google_calendar_events
    WHERE assignment_key = ?
  `);

  let created = 0;
  let updated = 0;
  let removed = 0;
  let unchanged = 0;
  let pastSkipped = 0;

  for (const activity of activities) {
    const existing = findMapping.get(activity.key);

    if (activity.submitted) {
      if (existing) {
        try {
          await calendar.events.delete({
            calendarId: GOOGLE_CALENDAR_ID,
            eventId: existing.google_event_id,
          });
        } catch (error) {
          const status =
            error.response?.status ||
            error.response?.statusCode ||
            error.code;

          if (![404, 410].includes(Number(status))) {
            throw error;
          }
        }

        deleteMapping.run(activity.key);
        removed += 1;

        console.log(`Removed submitted activity: ${activity.name}`);
      }

      continue;
    }

    if (!existing && new Date(activity.dueAt).getTime() < now) {
      pastSkipped += 1;
      continue;
    }

    const event = buildGoogleEvent(activity);
    const contentHash = createContentHash(event);

    if (!existing) {
      const result = await calendar.events.insert({
        calendarId: GOOGLE_CALENDAR_ID,
        requestBody: event,
      });

      if (!result.data.id) {
        throw new Error(
          `Google did not return an event ID for ${activity.name}`
        );
      }

      saveMapping.run(
        activity.key,
        result.data.id,
        activity.dueAt,
        contentHash,
        new Date().toISOString()
      );

      created += 1;
      console.log(`Created: ${activity.name}`);
      continue;
    }

    if (
      existing.due_at === activity.dueAt &&
      existing.content_hash === contentHash
    ) {
      unchanged += 1;
      continue;
    }

    try {
      await calendar.events.update({
        calendarId: GOOGLE_CALENDAR_ID,
        eventId: existing.google_event_id,
        requestBody: event,
      });

      saveMapping.run(
        activity.key,
        existing.google_event_id,
        activity.dueAt,
        contentHash,
        new Date().toISOString()
      );

      updated += 1;
      console.log(`Updated: ${activity.name}`);
    } catch (error) {
      const status =
        error.response?.status ||
        error.response?.statusCode ||
        error.code;

      if (Number(status) !== 404) {
        throw error;
      }

      const result = await calendar.events.insert({
        calendarId: GOOGLE_CALENDAR_ID,
        requestBody: event,
      });

      saveMapping.run(
        activity.key,
        result.data.id,
        activity.dueAt,
        contentHash,
        new Date().toISOString()
      );

      created += 1;
      console.log(`Recreated: ${activity.name}`);
    }
  }

  console.log("");
  console.log(`Canvas dated assignments checked: ${activities.length}`);
  console.log(`Calendar events created: ${created}`);
  console.log(`Calendar events updated: ${updated}`);
  console.log(`Submitted events removed: ${removed}`);
  console.log(`Calendar events unchanged: ${unchanged}`);
  console.log(`Old unsynced assignments skipped: ${pastSkipped}`);
}

main().catch((error) => {
  console.error(
    "Calendar sync failed:",
    error.response?.data?.error?.message || error.message
  );

  process.exit(1);
});

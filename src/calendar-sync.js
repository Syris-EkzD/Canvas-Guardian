const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { google } = require("googleapis");
const {
  getAllActiveCourseAssignments,
} = require("./canvas-assignments");
const {
  getMonitoringState,
  getCalendarSyncEnabled,
} = require("./monitoring-state");
const { requireEnvironment } = require("./runtime-config");

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

function ensureCalendarTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS google_calendar_events (
      assignment_key TEXT PRIMARY KEY,
      google_event_id TEXT NOT NULL,
      due_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      synced_at TEXT NOT NULL
    );
  `);
}

function createDatabase() {
  const db = new Database(path.join(projectRoot, "data", "horus.db"));

  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  ensureCalendarTable(db);

  return db;
}

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

function getGoogleStatus(error) {
  return Number(
    error.response?.status ||
    error.response?.statusCode ||
    error.code
  );
}

function isGoneGoogleStatus(error) {
  return [404, 410].includes(getGoogleStatus(error));
}

async function deleteManagedGoogleEvent(calendar, calendarId, eventId) {
  try {
    await calendar.events.delete({
      calendarId,
      eventId,
    });
  } catch (error) {
    if (!isGoneGoogleStatus(error)) {
      throw error;
    }
  }
}

async function findManagedGoogleEvent(
  calendar,
  calendarId,
  assignmentKey
) {
  const matches = [];
  let pageToken;

  do {
    const response = await calendar.events.list({
      calendarId,
      privateExtendedProperty: [
        "managedBy=horus",
        `canvasAssignmentKey=${assignmentKey}`,
      ],
      showDeleted: false,
      maxResults: 2,
      ...(pageToken ? { pageToken } : {}),
    });

    for (const event of response.data?.items ?? []) {
      const properties = event.extendedProperties?.private;

      if (
        properties?.managedBy === "horus" &&
        properties?.canvasAssignmentKey === assignmentKey
      ) {
        matches.push(event);
      }
    }

    if (matches.length > 1) {
      break;
    }

    pageToken = response.data?.nextPageToken;
  } while (pageToken);

  if (matches.length > 1) {
    throw new Error(
      `Multiple managed Google Calendar events found for assignment ${assignmentKey}`
    );
  }

  if (matches.length === 1 && !matches[0].id) {
    throw new Error(
      `Managed Google Calendar event for assignment ${assignmentKey} did not include an event ID`
    );
  }

  return matches[0] ?? null;
}

async function insertGoogleEvent(
  calendar,
  calendarId,
  activity,
  event
) {
  const result = await calendar.events.insert({
    calendarId,
    requestBody: event,
  });

  if (!result.data?.id) {
    throw new Error(
      `Google did not return an event ID for ${activity.name}`
    );
  }

  return result.data.id;
}

async function recoverOrCreateGoogleEvent({
  calendar,
  calendarId,
  activity,
  event,
  now,
  skipNewPastDue,
}) {
  const recovered = await findManagedGoogleEvent(
    calendar,
    calendarId,
    activity.key
  );

  if (recovered) {
    try {
      await calendar.events.update({
        calendarId,
        eventId: recovered.id,
        requestBody: event,
      });

      return {
        eventId: recovered.id,
        recovered: true,
        created: false,
        skipped: false,
      };
    } catch (error) {
      if (!isGoneGoogleStatus(error)) {
        throw error;
      }
    }
  }

  if (
    skipNewPastDue &&
    new Date(activity.dueAt).getTime() < now
  ) {
    return {
      eventId: null,
      recovered: false,
      created: false,
      skipped: true,
    };
  }

  const eventId = await insertGoogleEvent(
    calendar,
    calendarId,
    activity,
    event
  );

  return {
    eventId,
    recovered: false,
    created: true,
    skipped: false,
  };
}

async function syncCalendarAssignments({
  assignments,
  calendar,
  calendarId,
  db,
  now = Date.now(),
  log = console.log,
}) {
  const snapshot = assignments.map((assignment) => ({
    ...assignment,
    excused: assignment.excused === true,
  }));
  const assignmentsByKey = new Map(
    snapshot.map((assignment) => [assignment.key, assignment])
  );

  const listMappings = db.prepare(`
    SELECT assignment_key, google_event_id, due_at, content_hash
    FROM google_calendar_events
  `);

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
  let recovered = 0;
  let updated = 0;
  let removed = 0;
  let unchanged = 0;
  let pastSkipped = 0;

  for (const mapping of listMappings.all()) {
    const assignment = assignmentsByKey.get(mapping.assignment_key);
    const ineligible =
      !assignment ||
      !assignment.published ||
      !assignment.dueAt ||
      assignment.submitted;

    if (!ineligible) {
      continue;
    }

    await deleteManagedGoogleEvent(
      calendar,
      calendarId,
      mapping.google_event_id
    );

    deleteMapping.run(mapping.assignment_key);
    removed += 1;

    if (assignment?.submitted) {
      log(`Removed submitted activity: ${assignment.name}`);
    } else if (assignment) {
      log(`Removed ineligible activity: ${assignment.name}`);
    } else {
      log(`Removed disappeared assignment mapping: ${mapping.assignment_key}`);
    }
  }

  const eligibleActivities = snapshot
    .filter(
      (assignment) =>
        assignment.published &&
        assignment.dueAt &&
        !assignment.submitted
    )
    .sort(
      (a, b) =>
        new Date(a.dueAt).getTime() -
        new Date(b.dueAt).getTime()
    );

  for (const activity of eligibleActivities) {
    const existing = findMapping.get(activity.key);
    const event = buildGoogleEvent(activity);
    const contentHash = createContentHash(event);

    if (!existing) {
      const result = await recoverOrCreateGoogleEvent({
        calendar,
        calendarId,
        activity,
        event,
        now,
        skipNewPastDue: true,
      });

      if (result.skipped) {
        pastSkipped += 1;
        continue;
      }

      saveMapping.run(
        activity.key,
        result.eventId,
        activity.dueAt,
        contentHash,
        new Date(now).toISOString()
      );

      if (result.recovered) {
        recovered += 1;
        log(`Recovered: ${activity.name}`);
      } else {
        created += 1;
        log(`Created: ${activity.name}`);
      }

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
        calendarId,
        eventId: existing.google_event_id,
        requestBody: event,
      });

      saveMapping.run(
        activity.key,
        existing.google_event_id,
        activity.dueAt,
        contentHash,
        new Date(now).toISOString()
      );

      updated += 1;
      log(`Updated: ${activity.name}`);
    } catch (error) {
      if (!isGoneGoogleStatus(error)) {
        throw error;
      }

      const result = await recoverOrCreateGoogleEvent({
        calendar,
        calendarId,
        activity,
        event,
        now,
        skipNewPastDue: false,
      });

      saveMapping.run(
        activity.key,
        result.eventId,
        activity.dueAt,
        contentHash,
        new Date(now).toISOString()
      );

      if (result.recovered) {
        recovered += 1;
        log(`Recovered: ${activity.name}`);
      } else {
        created += 1;
        log(`Recreated: ${activity.name}`);
      }
    }
  }

  return {
    assignmentsChecked: snapshot.length,
    eligibleChecked: eligibleActivities.length,
    created,
    recovered,
    updated,
    removed,
    unchanged,
    pastSkipped,
  };
}

async function main() {
  require("dotenv").config({ quiet: true });

  const config = requireEnvironment([
    "CANVAS_BASE_URL",
    "CANVAS_ACCESS_TOKEN",
    "GOOGLE_CALENDAR_ID",
  ]);
  const db = createDatabase();
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

  // Reconciliation only happens after this complete paginated Canvas fetch
  // succeeds. A failed fetch never becomes an empty assignment snapshot.
  const assignments = await getAllActiveCourseAssignments();
  const stats = await syncCalendarAssignments({
    assignments,
    calendar,
    calendarId: config.GOOGLE_CALENDAR_ID,
    db,
  });

  console.log("");
  console.log(`Canvas assignments checked: ${stats.assignmentsChecked}`);
  console.log(`Calendar-eligible assignments checked: ${stats.eligibleChecked}`);
  console.log(`Calendar events created: ${stats.created}`);
  console.log(`Calendar mappings recovered: ${stats.recovered}`);
  console.log(`Calendar events updated: ${stats.updated}`);
  console.log(`Ineligible/submitted events removed: ${stats.removed}`);
  console.log(`Calendar events unchanged: ${stats.unchanged}`);
  console.log(`Old unsynced assignments skipped: ${stats.pastSkipped}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      "Calendar sync failed:",
      error.response?.data?.error?.message || error.message
    );

    process.exit(1);
  });
}

module.exports = {
  buildGoogleEvent,
  createContentHash,
  ensureCalendarTable,
  findManagedGoogleEvent,
  syncCalendarAssignments,
};

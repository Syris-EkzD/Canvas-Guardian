require("dotenv").config({ quiet: true });

const path = require("path");
const Database = require("better-sqlite3");
const { getAllActiveCourseAssignments } = require("./canvas-assignments");
const { filterPendingAssignments } = require("./activity-logic");
const { getMonitoringState } = require("./monitoring-state");

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_ALLOWED_CHAT_ID,
} = process.env;

const db = new Database(path.join(__dirname, "..", "data", "horus.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS deadline_reminders (
    assignment_key TEXT NOT NULL,
    due_at TEXT NOT NULL,
    reminder_type TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    PRIMARY KEY (assignment_key, due_at, reminder_type)
  );
`);

function formatDate(dateString) {
  return new Date(dateString).toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

async function getPendingActivities() {
  const assignments = await getAllActiveCourseAssignments();

  return filterPendingAssignments(assignments)
    .filter((assignment) => assignment.dueAt)
    .sort(
      (a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime()
    );
}

async function sendTelegramMessage(text) {
  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_ALLOWED_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram returned HTTP ${response.status}: ${body}`);
  }
}

function getReminderType(dueAt, now = Date.now()) {
  const millisecondsRemaining =
    new Date(dueAt).getTime() - new Date(now).getTime();
  const hoursRemaining = millisecondsRemaining / (1000 * 60 * 60);

  if (hoursRemaining <= 0) {
    return null;
  }

  if (hoursRemaining <= 3) {
    return {
      type: "3_hours",
      label: "within 3 hours",
    };
  }

  if (hoursRemaining <= 24) {
    return {
      type: "24_hours",
      label: "within 24 hours",
    };
  }

  return null;
}

async function main() {
  const monitoringState = getMonitoringState(db);

  if (monitoringState !== "running") {
    console.log(`Horus is ${monitoringState}. Monitor check skipped.`);
    return;
  }

  const activities = await getPendingActivities();

  const wasSent = db.prepare(`
    SELECT 1
    FROM deadline_reminders
    WHERE assignment_key = ?
      AND due_at = ?
      AND reminder_type = ?
  `);

  const saveReminder = db.prepare(`
    INSERT OR IGNORE INTO deadline_reminders (
      assignment_key,
      due_at,
      reminder_type,
      sent_at
    )
    VALUES (?, ?, ?, ?)
  `);

  let remindersSent = 0;

  for (const activity of activities) {
    const reminder = getReminderType(activity.dueAt);

    if (!reminder) {
      continue;
    }

    const alreadySent = wasSent.get(
      activity.key,
      activity.dueAt,
      reminder.type
    );

    if (alreadySent) {
      continue;
    }

    await sendTelegramMessage(
      [
        `⏰ Canvas deadline — due ${reminder.label}`,
        activity.course,
        "",
        activity.name,
        `Due: ${formatDate(activity.dueAt)}`,
        "Status: Not submitted",
        activity.htmlUrl
          ? `\nView in Canvas: ${activity.htmlUrl}`
          : "",
      ].join("\n")
    );

    saveReminder.run(
      activity.key,
      activity.dueAt,
      reminder.type,
      new Date().toISOString()
    );

    remindersSent += 1;
    console.log(`Reminder sent: ${activity.name} (${reminder.type})`);
  }

  console.log(`Checked ${activities.length} pending dated activities.`);
  console.log(`Deadline reminders sent: ${remindersSent}`);
}

main().catch((error) => {
  console.error("Deadline monitor failed:", error.message);
  process.exit(1);
});

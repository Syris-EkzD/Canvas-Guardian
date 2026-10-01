require("dotenv").config({ quiet: true });

const path = require("path");
const Database = require("better-sqlite3");
const { canvasGet } = require("./canvas-client");
const { getMonitoringState } = require("./monitoring-state");

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_ALLOWED_CHAT_ID,
} = process.env;

const db = new Database(path.join(__dirname, "..", "data", "horus.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS seen_activities (
    id TEXT PRIMARY KEY,
    seen_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

function getSetting(key) {
  return db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key)?.value;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function formatDate(dateString) {
  if (!dateString) return "No due date";

  return new Date(dateString).toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

async function getPendingActivities() {
  const courses = await canvasGet(
    "/api/v1/courses?enrollment_state=active&per_page=100"
  );

  const activities = [];

  for (const course of courses) {
    const assignments = await canvasGet(
      `/api/v1/courses/${course.id}/assignments?include[]=submission&order_by=due_at&per_page=100`
    );

    for (const assignment of assignments) {
      const submission = assignment.submission;

      const isSubmitted =
        Boolean(submission?.submitted_at) ||
        submission?.workflow_state === "submitted" ||
        submission?.workflow_state === "graded";

      if (assignment.published && !isSubmitted && !submission?.excused) {
        activities.push({
          id: String(assignment.id),
          course: course.course_code || course.name,
          name: assignment.name,
          dueAt: assignment.due_at,
          htmlUrl: assignment.html_url,
        });
      }
    }
  }

  return activities;
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
    throw new Error(`Telegram returned HTTP ${response.status}`);
  }
}

async function main() {
  const monitoringState = getMonitoringState(db);

  if (monitoringState !== "running") {
    console.log(`Horus is ${monitoringState}. Monitor check skipped.`);
    return;
  }

  const activities = await getPendingActivities();
  const firstRun = !getSetting("activity_baseline_created");

  const saveActivity = db.prepare(`
    INSERT OR IGNORE INTO seen_activities (id, seen_at)
    VALUES (?, ?)
  `);

  if (firstRun) {
    const saveAll = db.transaction((items) => {
      for (const item of items) {
        saveActivity.run(item.id, new Date().toISOString());
      }
    });

    saveAll(activities);
    setSetting("activity_baseline_created", new Date().toISOString());

    await sendTelegramMessage(
      `✅ Horus is now monitoring ${activities.length} current pending Canvas activity/activities. New activities will be sent here.`
    );

    console.log(`Baseline saved: ${activities.length} current pending activity/activities.`);
    return;
  }

  const isSeen = db.prepare("SELECT 1 FROM seen_activities WHERE id = ?");

  const newActivities = activities.filter((activity) => !isSeen.get(activity.id));

  for (const activity of newActivities) {
    await sendTelegramMessage(
      [
        "📚 New Canvas activity",
        activity.course,
        "",
        activity.name,
        `Due: ${formatDate(activity.dueAt)}`,
        "Status: Not started",
        activity.htmlUrl ? `\nView in Canvas: ${activity.htmlUrl}` : "",
      ].join("\n")
    );

    saveActivity.run(activity.id, new Date().toISOString());
    console.log(`Sent: ${activity.name}`);
  }

  console.log(`Checked ${activities.length} pending activity/activities.`);
  console.log(`New activity/activities: ${newActivities.length}`);
}

main().catch((error) => {
  console.error("Activity monitor failed:", error.message);
  process.exit(1);
});

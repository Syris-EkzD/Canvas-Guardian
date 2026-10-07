const path = require("path");
const Database = require("better-sqlite3");
const { getAllActiveCourseAssignments } = require("./canvas-assignments");
const { filterPendingAssignments } = require("./activity-logic");
const { getMonitoringState } = require("./monitoring-state");
const { requireEnvironment } = require("./runtime-config");
const { createTelegramClient } = require("./telegram-client");

function createDatabase() {
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

  return db;
}

function getSetting(db, key) {
  return db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key)?.value;
}

function setSetting(db, key, value) {
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
  const assignments = await getAllActiveCourseAssignments();

  return filterPendingAssignments(assignments);
}

async function main() {
  require("dotenv").config({ quiet: true });

  const config = requireEnvironment([
    "CANVAS_BASE_URL",
    "CANVAS_ACCESS_TOKEN",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_ALLOWED_CHAT_ID",
  ]);
  const telegram = createTelegramClient(config.TELEGRAM_BOT_TOKEN);
  const db = createDatabase();
  const monitoringState = getMonitoringState(db);

  if (monitoringState !== "running") {
    console.log(`Horus is ${monitoringState}. Monitor check skipped.`);
    return;
  }

  const activities = await getPendingActivities();
  const firstRun = !getSetting(db, "activity_baseline_created");

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
    setSetting(db, "activity_baseline_created", new Date().toISOString());

    await telegram.sendMessage(
      config.TELEGRAM_ALLOWED_CHAT_ID,
      `✅ Horus is now monitoring ${activities.length} current pending Canvas activity/activities. New activities will be sent here.`
    );

    console.log(`Baseline saved: ${activities.length} current pending activity/activities.`);
    return;
  }

  const isSeen = db.prepare("SELECT 1 FROM seen_activities WHERE id = ?");

  const newActivities = activities.filter((activity) => !isSeen.get(activity.id));

  for (const activity of newActivities) {
    await telegram.sendMessage(
      config.TELEGRAM_ALLOWED_CHAT_ID,
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

if (require.main === module) {
  main().catch((error) => {
    console.error("Activity monitor failed:", error.message);
    process.exit(1);
  });
}

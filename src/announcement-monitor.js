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
  CREATE TABLE IF NOT EXISTS seen_announcements (
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

async function getAnnouncements() {
  const courses = await canvasGet(
    "/api/v1/courses?enrollment_state=active&per_page=100"
  );

  const courseNames = new Map(
    courses.map((course) => [
      `course_${course.id}`,
      course.course_code || course.name,
    ])
  );

  const parameters = new URLSearchParams();
  parameters.set("per_page", "100");

  for (const course of courses) {
    parameters.append("context_codes[]", `course_${course.id}`);
  }

  const announcements = await canvasGet(
    `/api/v1/announcements?${parameters.toString()}`
  );

  return announcements.map((announcement) => ({
    ...announcement,
    courseName: courseNames.get(announcement.context_code) || "Canvas course",
  }));
}

function cleanText(html = "") {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
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

  const announcements = await getAnnouncements();

  const firstRun = !getSetting("announcement_baseline_created");

  if (firstRun) {
    const saveAnnouncement = db.prepare(`
      INSERT OR IGNORE INTO seen_announcements (id, seen_at)
      VALUES (?, ?)
    `);

    const saveAll = db.transaction((items) => {
      for (const item of items) {
        saveAnnouncement.run(String(item.id), new Date().toISOString());
      }
    });

    saveAll(announcements);
    setSetting("announcement_baseline_created", new Date().toISOString());

    console.log(
      `Baseline saved: ${announcements.length} existing announcement(s). No old announcements were sent.`
    );

    await sendTelegramMessage(
      `✅ Horus is now monitoring ${announcements.length} existing Canvas announcement(s). New announcements will be sent here.`
    );

    return;
  }

  const isSeen = db.prepare(
    "SELECT 1 FROM seen_announcements WHERE id = ?"
  );
  const saveAnnouncement = db.prepare(`
    INSERT OR IGNORE INTO seen_announcements (id, seen_at)
    VALUES (?, ?)
  `);

  const newAnnouncements = announcements
    .filter((item) => !isSeen.get(String(item.id)))
    .sort(
      (a, b) =>
        new Date(a.posted_at || 0).getTime() -
        new Date(b.posted_at || 0).getTime()
    );

  for (const announcement of newAnnouncements) {
    const preview = cleanText(announcement.message).slice(0, 700);

    await sendTelegramMessage(
      [
        "📢 New Canvas announcement",
        announcement.courseName,
        "",
        announcement.title,
        preview ? `\n${preview}` : "",
        announcement.html_url ? `\nView in Canvas: ${announcement.html_url}` : "",
      ].join("\n")
    );

    saveAnnouncement.run(String(announcement.id), new Date().toISOString());
    console.log(`Sent: ${announcement.title}`);
  }

  console.log(`Checked ${announcements.length} announcement(s).`);
  console.log(`New announcement(s): ${newAnnouncements.length}`);
}

main().catch((error) => {
  console.error("Announcement monitor failed:", error.message);
  process.exit(1);
});

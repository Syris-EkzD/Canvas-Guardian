const path = require("path");
const Database = require("better-sqlite3");
const { canvasGetAll } = require("./canvas-client");
const { getAllActiveCourseAssignments } = require("./canvas-assignments");
const {
  filterActivitiesDueToday,
  filterActivitiesDueWithinWeek,
  filterPendingAssignments,
} = require("./activity-logic");
const {
  getMonitoringState,
  setMonitoringState,
  getCalendarSyncEnabled,
  setCalendarSyncEnabled,
} = require("./monitoring-state");
const { requireEnvironment } = require("./runtime-config");
const { createTelegramClient } = require("./telegram-client");

function createDatabase() {
  const db = new Database(path.join(__dirname, "..", "data", "horus.db"));

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  return db;
}

function getSetting(db, key) {
  return db
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .get(key)?.value;
}

function setSetting(db, key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function formatDate(dateString) {
  if (!dateString) {
    return "No due date";
  }

  return new Date(dateString).toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

async function getPendingActivities() {
  const assignments = await getAllActiveCourseAssignments();
  const activities = filterPendingAssignments(assignments);

  return activities.sort((a, b) => {
    if (!a.dueAt) return 1;
    if (!b.dueAt) return -1;

    return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
  });
}

async function sendActivityList(send, chatId, title, activities) {
  if (activities.length === 0) {
    await send(chatId, `${title}\n\nNo matching activities found.`);
    return;
  }

  let message = `${title}\n\n`;
  let part = 1;

  for (const [index, activity] of activities.entries()) {
    const block = [
      `${index + 1}. [${activity.course}]`,
      activity.name,
      `Due: ${formatDate(activity.dueAt)}`,
      activity.htmlUrl || "",
      "",
      "",  
    ].join("\n");

    if (message.length + block.length > 3800) {
      await send(chatId, message.trim());
      part += 1;
      message = `${title} — Part ${part}\n\n`;
    }

    message += block;
  }

  if (message.trim()) {
    await send(chatId, message.trim());
  }
}

function cleanText(html = "") {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function getRecentAnnouncements(limit = 10) {
  const courses = await canvasGetAll(
    "/api/v1/courses?enrollment_state=active&per_page=100"
  );

  if (courses.length === 0) {
    return [];
  }

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

  const announcements = await canvasGetAll(
    `/api/v1/announcements?${parameters.toString()}`
  );

  return announcements
    .map((announcement) => ({
      course:
        courseNames.get(announcement.context_code) || "Canvas course",
      title: announcement.title,
      preview: cleanText(announcement.message).slice(0, 250),
      postedAt: announcement.posted_at,
      htmlUrl: announcement.html_url,
    }))
    .sort(
      (a, b) =>
        new Date(b.postedAt || 0).getTime() -
        new Date(a.postedAt || 0).getTime()
    )
    .slice(0, limit);
}

async function sendAnnouncementList(send, chatId, announcements) {
  if (announcements.length === 0) {
    await send(chatId, "📢 No announcements found.");
    return;
  }

  let message = `📢 Latest announcements: ${announcements.length}\n\n`;
  let part = 1;

  for (const [index, announcement] of announcements.entries()) {
    const block = [
      `${index + 1}. [${announcement.course}]`,
      announcement.title,
      `Posted: ${formatDate(announcement.postedAt)}`,
      announcement.preview,
      announcement.htmlUrl || "",
      "",
      "",
    ].join("\n");

    if (message.length + block.length > 3800) {
      await send(chatId, message.trim());
      part += 1;
      message = `📢 Latest announcements — Part ${part}\n\n`;
    }

    message += block;
  }

  if (message.trim()) {
    await send(chatId, message.trim());
  }
}

async function handleMessage(message, runtime) {
  const { db, allowedChatId, send } = runtime;

  if (!message?.text) {
    return;
  }

  if (String(message.chat.id) !== String(allowedChatId)) {
    console.log(`Ignored unauthorized chat: ${message.chat.id}`);
    return;
  }

  const messageParts = message.text.trim().split(/\s+/);

  const command = messageParts[0]   
    .split("@")[0]    
    .toLowerCase();   

  const option = messageParts[1]?.toLowerCase();    

  if (command === "/start") {
    const previousState = getMonitoringState(db);
    setMonitoringState(db, "running");

    await send(
      message.chat.id,
      previousState === "running"
        ? "✅ Horus is already running."
        : "▶️ Horus started. Automatic Canvas monitoring is now active."
    );

    return;
  }

  if (command === "/stop") {
    const currentState = getMonitoringState(db);

    if (currentState === "stopped") {
      await send(message.chat.id, "⏹ Horus is already stopped.");
      return;
    }

    setMonitoringState(db, "stopped");

    await send(
      message.chat.id,
      [
        "⏹ Horus stopped.",
        "Automatic Canvas monitoring is disabled.",
        "Use /start when you want to activate it again.",
      ].join("\n")
    );

    return;
  }

  if (command === "/pause") {
    const currentState = getMonitoringState(db);

    if (currentState === "stopped") {
      await send(
        message.chat.id,
        "Horus is stopped. Use /start instead."
      );

      return;
    }

    if (currentState === "paused") {
      await send(message.chat.id, "⏸ Horus is already paused.");
      return;
    }

    setMonitoringState(db, "paused");

    await send(
      message.chat.id,
      [
        "⏸ Horus paused.",
        "Automatic Canvas monitoring is temporarily suspended.",
        "Use /resume to continue.",
      ].join("\n")
    );

    return;
  }

  if (command === "/resume") {
    const currentState = getMonitoringState(db);

    if (currentState === "stopped") {
      await send(
        message.chat.id,
        "Horus is stopped. Use /start instead."
      );

      return;
    }

    if (currentState === "running") {
      await send(message.chat.id, "✅ Horus is already running.");
      return;
    }

    setMonitoringState(db, "running");

    await send(
      message.chat.id,
      "▶️ Horus resumed. Automatic Canvas monitoring is active."
    );

    return;
  }

  if (command === "/status") {
    const currentState = getMonitoringState(db);
    const calendarSyncEnabled = getCalendarSyncEnabled(db);

    const statusIndicators = {
      running: "🟢 RUNNING",
      paused: "🟡 PAUSED",
      stopped: "🔴 STOPPED",
    };

    const descriptions = {
      running: "Automatic Canvas monitoring is active.",
      paused: "Automatic Canvas monitoring is temporarily suspended.",
      stopped: "Automatic Canvas monitoring is disabled.",
    };

    await send(
      message.chat.id,
      [
        "🛡 Horus status",
        "",
        `Monitoring: ${statusIndicators[currentState]}`,
        `Calendar sync: ${
          calendarSyncEnabled ? "🟢 ENABLED" : "🔴 DISABLED"
        }`,
        "Command bot: 🟢 ONLINE",
        "Check interval: Every 10 minutes",
        "Timezone: Asia/Manila",
        "",
        descriptions[currentState],
      ].join("\n")
    );

    return;
  }

  if (command === "/help") {
    await send(
      message.chat.id,
      [
        "🛡 Horus commands",
        "",
        "/start — start automatic monitoring",
        "/stop — stop automatic monitoring",
        "/pause — temporarily pause monitoring",
        "/resume — resume paused monitoring",
        "/status — show Horus’s current state",
        "/pending — show all unfinished activities",
        "/today — show activities due today",
        "/week — show activities due within 7 days",
        "/help — show this command list",
        "/calendar on|off|status — control calendar synchronization",
      ].join("\n")
    );

    return;
  }

  if (command === "/announcements") {
    await send(message.chat.id, "Checking Canvas announcements…");

    const announcements = await getRecentAnnouncements(10);

    await sendAnnouncementList(send, message.chat.id, announcements);
    return;
  }

  if (command === "/calendar") {
    const currentlyEnabled = getCalendarSyncEnabled(db);

    if (!option || option === "status") {
      await send(
        message.chat.id,
        [
          "📅 Horus Calendar synchronization",
          "",
          `Status: ${
            currentlyEnabled ? "🟢 ENABLED" : "🔴 DISABLED"
          }`,
          "",
          "Use /calendar on or /calendar off.",
        ].join("\n")
      );

      return;
    }

    if (option === "on") {
      if (currentlyEnabled) {
        await send(
          message.chat.id,
          "📅 Calendar synchronization is already 🟢 ENABLED."
        );

        return;
      }

      setCalendarSyncEnabled(db, true);

      await send(
        message.chat.id,
        [
          "📅 Calendar synchronization: 🟢 ENABLED",
          "",
          "Horus will resume updating Google and Samsung Calendar within 10 minutes.",
        ].join("\n")
      );

      return;
    }

    if (option === "off") {
      if (!currentlyEnabled) {
        await send(
          message.chat.id,
          "📅 Calendar synchronization is already 🔴 DISABLED."
        );

        return;
      }

      setCalendarSyncEnabled(db, false);

      await send(
        message.chat.id,
        [
          "📅 Calendar synchronization: 🔴 DISABLED",
          "",
          "Existing calendar events were kept unchanged.",
        ].join("\n")
      );

      return;
    }

    await send(
      message.chat.id,
      "Use /calendar on, /calendar off, or /calendar status."
    );

    return;
  }

  if (!["/pending", "/today", "/week"].includes(command)) {
    await send(
      message.chat.id,
      "Unknown command. Use /help to see the available commands."
    );

    return;
  }

  await send(message.chat.id, "Checking Canvas…");

  const activities = await getPendingActivities();
  const now = new Date();

  if (command === "/pending") {
    await sendActivityList(
      send,
      message.chat.id,
      `📚 Pending activities: ${activities.length}`,
      activities
    );

    return;
  }

  if (command === "/today") {
    const todayActivities = filterActivitiesDueToday(activities, now);

    await sendActivityList(
      send,
      message.chat.id,
      `📅 Due today: ${todayActivities.length}`,
      todayActivities
    );

    return;
  }

  const weekActivities = filterActivitiesDueWithinWeek(activities, now);

  await sendActivityList(
    send,
    message.chat.id,
    `🗓 Due within 7 days: ${weekActivities.length}`,
    weekActivities
  );
}

async function initializeOffset(db, call) {
  const savedOffset = getSetting(db, "telegram_update_offset");

  if (savedOffset !== undefined) {
    return Number(savedOffset);
  }

  const existingUpdates = await call("getUpdates", {
    timeout: 0,
    allowed_updates: ["message"],
  });

  const offset =
    existingUpdates.length > 0
      ? Math.max(...existingUpdates.map((update) => update.update_id)) + 1
      : 0;

  setSetting(db, "telegram_update_offset", String(offset));
  return offset;
}

async function main() {
  require("dotenv").config({ quiet: true });

  const config = requireEnvironment([
    "CANVAS_BASE_URL",
    "CANVAS_ACCESS_TOKEN",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_ALLOWED_CHAT_ID",
  ]);
  const db = createDatabase();
  const telegram = createTelegramClient(config.TELEGRAM_BOT_TOKEN);
  const send = telegram.sendMessage;
  let offset = await initializeOffset(db, telegram.call);

  console.log("Horus Telegram command bot is listening.");
  console.log("Send /pending, /today, or /week in Telegram.");

  while (true) {
    try {
      const updates = await telegram.call("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message"],
      });

      for (const update of updates) {
        try {
          await handleMessage(update.message, {
            db,
            allowedChatId: config.TELEGRAM_ALLOWED_CHAT_ID,
            send,
          });
        } catch (error) {
          console.error("Command failed:", error.message);

          if (
            String(update.message?.chat?.id) ===
            String(config.TELEGRAM_ALLOWED_CHAT_ID)
          ) {
            await send(
              update.message.chat.id,
              "Horus could not complete that command. Please try again."
            );
          }
        }

        offset = update.update_id + 1;
        setSetting(db, "telegram_update_offset", String(offset));
      }
    } catch (error) {
      console.error("Telegram polling failed:", error.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Telegram bot failed:", error.message);
    process.exit(1);
  });
}

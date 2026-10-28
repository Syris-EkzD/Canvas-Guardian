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
const { createReportFromCsv } = require("./academic-pipeline");
const {
  clearActivityStatusOverride,
  getEffectiveActivityStatus,
  setActivityStatusOverride,
} = require("./activity-status");

const DEFAULT_CSV_LIMIT = 5 * 1024 * 1024;
const REPORT_TIMEOUT_MS = 120_000;
const PAGE_SIZE = 8;
const COMMANDS = Object.freeze([
  { command: "start", description: "Start automatic monitoring" },
  { command: "stop", description: "Stop automatic monitoring" },
  { command: "pause", description: "Pause automatic monitoring" },
  { command: "resume", description: "Resume automatic monitoring" },
  { command: "status", description: "Show monitoring status" },
  { command: "pending", description: "Browse unfinished activities" },
  { command: "today", description: "Browse activities due today" },
  { command: "week", description: "Browse activities due within 7 days" },
  { command: "activities", description: "Find dismissed and offline completed work" },
  { command: "announcements", description: "Show recent Canvas announcements" },
  { command: "calendar", description: "Toggle calendar synchronization" },
  { command: "calendar_status", description: "Show calendar synchronization status" },
  { command: "report", description: "Create an Excel report from a Roll Call CSV" },
  { command: "help", description: "Show available commands" },
]);

async function registerCommands(telegram, chatId, logger = console) {
  const scope = { type: "chat", chat_id: chatId };
  try {
    const current = await telegram.call("getMyCommands", { scope });
    if (JSON.stringify(current) !== JSON.stringify(COMMANDS)) {
      await telegram.call("setMyCommands", { scope, commands: COMMANDS });
    }
  } catch {
    logger.error("Telegram command registration failed; polling will continue.");
  }
}

function parseCsvLimit(value) {
  if (value === undefined || value === "") return DEFAULT_CSV_LIMIT;
  const mib = Number(value);
  if (!Number.isInteger(mib) || mib < 1 || mib > 20) {
    throw new Error("TELEGRAM_REPORT_MAX_CSV_MIB must be an integer from 1 to 20");
  }
  return mib * 1024 * 1024;
}

function createReportHandler({ telegram, maxCsvBytes = DEFAULT_CSV_LIMIT, createReport = createReportFromCsv, reportTimeoutMs = REPORT_TIMEOUT_MS }) {
  let busy = false;
  return async function handleReportDocument(message) {
    const chatId = message.chat.id;
    const document = message.document;
    if (busy) {
      await telegram.sendMessage(chatId, "A report is already being generated. Please try again shortly.");
      return;
    }
    if (!document?.file_id || (document.file_size !== undefined && (!Number.isSafeInteger(document.file_size) || document.file_size < 1))) {
      await telegram.sendMessage(chatId, "Please upload one valid Roll Call CSV document.");
      return;
    }
    if (document.file_size > maxCsvBytes) {
      await telegram.sendMessage(chatId, "CSV exceeds the configured size limit.");
      return;
    }

    busy = true;
    const signal = AbortSignal.timeout(reportTimeoutMs);
    try {
      await telegram.sendMessage(chatId, "Generating your academic report…");
      const csv = await telegram.downloadFile(document.file_id, maxCsvBytes, signal);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(csv);
      const { workbook } = await createReport(text, undefined, { signal });
      const output = Buffer.from(await workbook.xlsx.writeBuffer());
      await telegram.sendDocument(chatId, output, "academic-report.xlsx", signal);
      await telegram.sendMessage(chatId, "Academic report ready.").catch(() => {});
    } catch (error) {
      const safe = /^(Attendance CSV|Invalid attendance CSV|No attendance records|CSV exceeds|Telegram file download failed|Telegram returned an invalid file path|Report exceeds)/.test(error.message);
      await telegram.sendMessage(chatId, safe ? error.message : "Could not generate or deliver the report. Please try again.");
    } finally {
      busy = false;
    }
  };
}

function createUpdateProcessor(initialOffset, handle, persist, isReport, onBackgroundError, handleCallback = async () => {}) {
  let offset = initialOffset;

  return {
    getOffset: () => offset,
    async process(update) {
      if (update.update_id < offset) return;

      if (update.callback_query) {
        await handleCallback(update.callback_query);
      } else if (isReport(update.message)) {
        // Reports run in the background so other commands remain responsive.
        // Telegram acknowledges an update on the next getUpdates call with a
        // higher offset; this checkpoint cannot guarantee report recovery.
        const work = handle(update.message);
        void Promise.resolve(work).catch(onBackgroundError);
      } else {
        await handle(update.message);
      }

      const nextOffset = update.update_id + 1;
      persist(nextOffset);
      offset = nextOffset;
    },
  };
}

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

function activityCandidates(assignments, db, view, now = new Date()) {
  let items = view === "a"
    ? assignments.filter((item) => ["dismissed", "completed_offline"].includes(getEffectiveActivityStatus(db, item)))
    : filterPendingAssignments(assignments, db);
  if (view === "t") items = filterActivitiesDueToday(items, now);
  if (view === "w") items = filterActivitiesDueWithinWeek(items, now);
  return items.sort((a, b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity));
}

function activityPage(assignments, db, view, page, now) {
  const labels = { p: "📚 Pending activities", t: "📅 Due today", w: "🗓 Due within 7 days", a: "🗂 Saved activity statuses" };
  const items = activityCandidates(assignments, db, view, now);
  const maxPage = Math.max(0, Math.ceil(items.length / PAGE_SIZE) - 1);
  page = Math.min(page, maxPage);
  const shown = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const lines = shown.map((item, index) => `${page * PAGE_SIZE + index + 1}. [${String(item.course).slice(0, 45)}] ${String(item.name).slice(0, 100)}\nDue: ${formatDate(item.dueAt)}${view === "a" ? `\nGuardian: ${getEffectiveActivityStatus(db, item).replace("_", " ")}` : ""}`);
  const rows = shown.map((item, index) => [{ text: `${page * PAGE_SIZE + index + 1}. ${item.name}`.slice(0, 55), callback_data: `a1:s:${item.key}` }]);
  const navigation = [];
  if (page > 0) navigation.push({ text: "◀ Previous", callback_data: `a1:l:${view}:${page - 1}` });
  if (page < maxPage) navigation.push({ text: "Next ▶", callback_data: `a1:l:${view}:${page + 1}` });
  if (navigation.length) rows.push(navigation);
  return {
    text: `${labels[view]}: ${items.length}\nPage ${page + 1}/${maxPage + 1}\n\n${lines.join("\n\n") || "No matching activities found."}`,
    markup: { inline_keyboard: rows },
  };
}

function activityDetail(db, assignment) {
  const status = getEffectiveActivityStatus(db, assignment);
  const rows = [];
  if (status === "pending") {
    rows.push([{ text: "✅ Completed Offline", callback_data: `a1:c:${assignment.key}` }]);
    rows.push([{ text: "🙈 Dismiss", callback_data: `a1:d:${assignment.key}` }]);
  } else if (["completed_offline", "dismissed"].includes(status)) {
    rows.push([{ text: "↩ Restore Pending", callback_data: `a1:r:${assignment.key}` }]);
  }
  rows.push([{ text: "🔄 View current status", callback_data: `a1:s:${assignment.key}` }]);
  rows.push([{ text: "📚 Pending", callback_data: "a1:l:p:0" }, { text: "🗂 Saved", callback_data: "a1:l:a:0" }]);
  return {
    text: `[${assignment.course}] ${assignment.name}\nDue: ${formatDate(assignment.dueAt)}\nCanvas submission: ${assignment.submitted ? "Submitted" : "Not submitted"}\nGuardian status: ${status?.replace("_", " ") || "Unavailable"}${assignment.htmlUrl ? `\n${assignment.htmlUrl}` : ""}`,
    markup: { inline_keyboard: rows },
  };
}

async function handleCallbackQuery(query, runtime) {
  const { db, allowedChatId, telegram, getAssignments = getAllActiveCourseAssignments } = runtime;
  if (!query?.id) return;
  const answer = async (text) => {
    try {
      await telegram.answerCallbackQuery(query.id, text);
    } catch {
      // An expired callback must not block activity handling or later updates.
      (runtime.logger ?? console).warn("Telegram callback acknowledgment failed; continuing.");
    }
  };
  if (query.message?.chat?.type !== "private" ||
      String(query.message.chat.id) !== String(allowedChatId) ||
      String(query.from?.id) !== String(allowedChatId)) {
    await answer("Not authorized.");
    return;
  }
  const data = query.data;
  const list = /^a1:l:([ptwa]):(0|[1-9]\d{0,5})$/.exec(data);
  const item = /^a1:([scdr]):([1-9]\d*:[1-9]\d*)$/.exec(data);
  if (typeof data !== "string" || Buffer.byteLength(data) > 64 || (!list && !item)) {
    await answer("This button is no longer valid. Use /pending or /activities.");
    return;
  }
  await answer("Checking activity…");
  const show = async (display) => {
    if (query.message.text === display.text) return;
    try {
      await telegram.editMessageText(query.message.chat.id, query.message.message_id, display.text, display.markup);
    } catch {
      await telegram.sendMessage(query.message.chat.id, display.text, display.markup);
    }
  };
  const navigation = { inline_keyboard: [[
    { text: "📚 Pending", callback_data: "a1:l:p:0" },
    { text: "🗂 Saved", callback_data: "a1:l:a:0" },
  ]] };
  let assignments;
  try {
    assignments = await getAssignments();
  } catch {
    await show({ text: "Could not load activities. Please try again.", markup: navigation }).catch(() => {});
    return;
  }
  let display;
  let notice = "";
  if (list) {
    display = activityPage(assignments, db, list[1], Number(list[2]));
  } else {
    const assignment = assignments.find((entry) => entry.key === item[2]);
    if (!assignment) {
      await show({ text: "Activity no longer found. Open a fresh list.", markup: navigation });
      return;
    }
    const current = getEffectiveActivityStatus(db, assignment);
    const desired = { c: "completed_offline", d: "dismissed", r: "pending" }[item[1]];
    if (desired) {
      if (current === "submitted" || current === null) {
        notice = "Canvas status changed; no local status was changed.";
      } else if (current === desired) {
        notice = "Already in that status.";
      } else if (desired === "pending" ? current === "pending" : current !== "pending") {
        notice = "Guardian status changed. Review the current status below.";
      } else if (desired === "pending") {
        clearActivityStatusOverride(db, assignment.key);
        notice = "Restored to Pending.";
      } else {
        setActivityStatusOverride(db, assignment.key, desired);
        notice = desired === "dismissed" ? "Dismissed." : "Marked Completed Offline. Canvas was not changed.";
      }
    }
    display = activityDetail(db, assignment);
  }
  if (notice) display.text += `\n\n${notice}`;
  await show(display);
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
  const { db, allowedChatId, send, reportDocument, getAssignments = getAllActiveCourseAssignments } = runtime;

  if (!message?.chat) {
    return;
  }

  if (message.chat.type !== "private" || String(message.chat.id) !== String(allowedChatId) ||
      (message.from && String(message.from.id) !== String(allowedChatId))) {
    return;
  }

  if (message.document) {
    if (message.chat.type === "private") {
      await reportDocument(message);
    }
    return;
  }

  if (!message.text) return;

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
        ...COMMANDS.map(({ command, description }) => `/${command} — ${description}`),
        "",
        "/calendar on|off|status also works.",
      ].join("\n")
    );

    return;
  }

  if (command === "/report") {
    await send(message.chat.id, "Upload one official Roll Call CSV document in this private chat. I’ll return an Excel report with Summary, Assignments, and Attendance sheets. The default CSV limit is 5 MiB (configurable by the operator).");
    return;
  }

  if (command === "/announcements") {
    await send(message.chat.id, "Checking Canvas announcements…");

    const announcements = await getRecentAnnouncements(10);

    await sendAnnouncementList(send, message.chat.id, announcements);
    return;
  }

  if (command === "/calendar" || command === "/calendar_status") {
    const currentlyEnabled = getCalendarSyncEnabled(db);

    if (command === "/calendar_status" || option === "status") {
      await send(
        message.chat.id,
        [
          "📅 Horus Calendar synchronization",
          "",
          `Status: ${
            currentlyEnabled ? "🟢 ENABLED" : "🔴 DISABLED"
          }`,
          "",
          "Use /calendar to toggle synchronization.",
        ].join("\n")
      );

      return;
    }

    const action = option || (currentlyEnabled ? "off" : "on");
    if (action === "on") {
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

    if (action === "off") {
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

  if (!["/pending", "/today", "/week", "/activities"].includes(command)) {
    await send(
      message.chat.id,
      "Unknown command. Use /help to see the available commands."
    );

    return;
  }

  const assignments = await getAssignments();
  const view = { "/pending": "p", "/today": "t", "/week": "w", "/activities": "a" }[command];
  const display = activityPage(assignments, db, view, 0);
  await send(message.chat.id, display.text, display.markup);
}

async function initializeOffset(db, call) {
  const savedOffset = getSetting(db, "telegram_update_offset");

  if (savedOffset !== undefined) {
    return Number(savedOffset);
  }

  const existingUpdates = await call("getUpdates", {
    timeout: 0,
    allowed_updates: ["message", "callback_query"],
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
  const reportDocument = createReportHandler({ telegram, maxCsvBytes: parseCsvLimit(process.env.TELEGRAM_REPORT_MAX_CSV_MIB) });
  const initialOffset = await initializeOffset(db, telegram.call);
  await registerCommands(telegram, config.TELEGRAM_ALLOWED_CHAT_ID);
  const runtime = {
    db,
    allowedChatId: config.TELEGRAM_ALLOWED_CHAT_ID,
    send,
    reportDocument,
    telegram,
  };
  const processMessage = async (message) => {
    try {
      await handleMessage(message, runtime);
    } catch (error) {
      console.error("Command failed:", error.message);
      if (String(message?.chat?.id) === String(config.TELEGRAM_ALLOWED_CHAT_ID)) {
        await send(message.chat.id, "Horus could not complete that command. Please try again.").catch(() => {});
      }
    }
  };
  const processor = createUpdateProcessor(
    initialOffset,
    processMessage,
    (offset) => setSetting(db, "telegram_update_offset", String(offset)),
    (message) => Boolean(message?.document && message.chat?.type === "private" &&
      String(message.chat.id) === String(config.TELEGRAM_ALLOWED_CHAT_ID)),
    (error) => console.error("Background report failed:", error.message),
    (query) => handleCallbackQuery(query, runtime)
  );

  console.log("Horus Telegram command bot is listening.");
  console.log("Send /pending, /today, or /week in Telegram.");

  while (true) {
    try {
      const updates = await telegram.call("getUpdates", {
        offset: processor.getOffset(),
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      });

      for (const update of updates) {
        await processor.process(update);
      }
    } catch (error) {
      console.error("Telegram polling failed:", error.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

module.exports = { COMMANDS, activityPage, createReportHandler, createUpdateProcessor, handleCallbackQuery, handleMessage, initializeOffset, parseCsvLimit, registerCommands };

if (require.main === module) {
  main().catch((error) => {
    console.error("Telegram bot failed:", error.message);
    process.exit(1);
  });
}

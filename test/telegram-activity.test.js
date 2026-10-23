const { test } = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { getActivityStatusOverride } = require("../src/activity-status");
const { filterPendingAssignments } = require("../src/activity-logic");
const { selectReminderCandidates } = require("../src/deadline-monitor");
const {
  COMMANDS, activityPage, createUpdateProcessor, handleCallbackQuery,
  handleMessage, initializeOffset, registerCommands,
} = require("../src/telegram-bot");

function fixture() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const assignments = Array.from({ length: 10 }, (_, index) => ({
    key: `12:${index + 1}`, id: String(index + 1), course: "Art", name: `Task ${index + 1}`,
    dueAt: "2026-10-25T12:00:00Z", published: true, submitted: false, excused: false,
  }));
  const sent = [];
  const edits = [];
  const answers = [];
  const telegram = {
    sendMessage: async (...args) => sent.push(args),
    editMessageText: async (...args) => edits.push(args),
    answerCallbackQuery: async (...args) => answers.push(args),
  };
  const runtime = { db, allowedChatId: 42, telegram, send: telegram.sendMessage,
    getAssignments: async () => assignments };
  const query = (data, from = 42, chat = 42) => ({ id: `q${answers.length}`, data,
    from: { id: from }, message: { message_id: 10, chat: { id: chat, type: "private" } } });
  return { db, assignments, sent, edits, answers, runtime, query };
}

test("paged pending selection, offline completion, dismissal, and restoration", async () => {
  const f = fixture();
  await handleMessage({ chat: { id: 42, type: "private" }, from: { id: 42 }, text: "/pending" }, f.runtime);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0][1], /Pending activities: 10/);
  assert.equal(f.sent[0][2].inline_keyboard.length, 9);
  assert.equal(f.sent[0][2].inline_keyboard.at(-1)[0].callback_data, "a1:l:p:1");
  await handleCallbackQuery(f.query("a1:l:p:1"), f.runtime);
  assert.match(f.edits.at(-1)[2], /Task 10/);
  await handleCallbackQuery(f.query("a1:s:12:1"), f.runtime);
  assert.match(f.edits.at(-1)[2], /Canvas submission: Not submitted/);
  assert.match(f.edits.at(-1)[2], /Guardian status: pending/);
  await handleCallbackQuery(f.query("a1:c:12:1"), f.runtime);
  assert.equal(getActivityStatusOverride(f.db, "12:1").status, "completed_offline");
  assert.match(f.answers.at(-1)[1], /Canvas was not changed/);
  await handleCallbackQuery(f.query("a1:c:12:1"), f.runtime);
  assert.equal(f.answers.at(-1)[1], "Already in that status.");
  await handleCallbackQuery(f.query("a1:d:12:2"), f.runtime);
  assert.equal(getActivityStatusOverride(f.db, "12:2").status, "dismissed");
  await handleCallbackQuery(f.query("a1:c:12:2"), f.runtime);
  assert.equal(getActivityStatusOverride(f.db, "12:2").status, "dismissed");
  assert.match(f.answers.at(-1)[1], /status changed/);
  assert.deepEqual(filterPendingAssignments(f.assignments, f.db).map(a => a.key).slice(0, 2), ["12:3", "12:4"]);
  assert.equal(selectReminderCandidates(f.assignments, f.db).length, 8);
  await handleMessage({ chat: { id: 42, type: "private" }, from: { id: 42 }, text: "/activities" }, f.runtime);
  assert.match(f.sent.at(-1)[1], /Saved activity statuses: 2/);
  await handleCallbackQuery(f.query("a1:r:12:2"), f.runtime);
  assert.equal(getActivityStatusOverride(f.db, "12:2"), null);
  assert.equal(selectReminderCandidates(f.assignments, f.db).length, 9);
  f.db.close();
});

test("callback authorization, malformed payloads, missing and submitted assignments", async () => {
  const f = fixture();
  for (const q of [f.query("a1:d:12:1", 77), f.query("a1:d:12:1", 42, 77), f.query("a1:d:bad"), f.query("a1:d:12:99")]) {
    await handleCallbackQuery(q, f.runtime);
  }
  assert.equal(getActivityStatusOverride(f.db, "12:1"), null);
  assert.equal(f.answers.length, 4);
  f.assignments[0].submitted = true;
  await handleCallbackQuery(f.query("a1:d:12:1"), f.runtime);
  assert.equal(getActivityStatusOverride(f.db, "12:1"), null);
  assert.match(f.answers.at(-1)[1], /Canvas status changed/);
  f.db.close();
});

test("obsolete Telegram message falls back to a fresh activity message", async () => {
  const f = fixture();
  f.runtime.telegram.editMessageText = async () => { throw new Error("private Telegram detail"); };
  await handleCallbackQuery(f.query("a1:s:12:1"), f.runtime);
  assert.equal(f.answers.length, 1);
  assert.match(f.sent[0][1], /Guardian status: pending/);
  f.db.close();
});

test("today and week pages honor overrides and Canvas submissions", async () => {
  const f = fixture();
  f.assignments[0].dueAt = "2026-10-24T09:00:00Z";
  f.assignments[1].dueAt = "2026-11-03T09:00:00Z";
  f.assignments[2].submitted = true;
  await handleCallbackQuery(f.query("a1:d:12:4"), f.runtime);
  const now = new Date("2026-10-24T01:00:00Z");
  const today = activityPage(f.assignments, f.db, "t", 0, now);
  const week = activityPage(f.assignments, f.db, "w", 0, now);
  assert.match(today.text, /Task 1/);
  assert.doesNotMatch(today.text, /Task 2/);
  assert.doesNotMatch(week.text, /Task 3|Task 4/);
  assert.doesNotMatch(week.text, /Task 2/);
  f.db.close();
});

test("callback offsets persist sequentially alongside background reports", async () => {
  const seen = [];
  const offsets = [];
  const processor = createUpdateProcessor(3, async (message) => seen.push(message.text),
    offset => offsets.push(offset), message => Boolean(message?.document), () => {},
    async query => seen.push(query.data));
  await processor.process({ update_id: 3, callback_query: { data: "a1:s:12:1" } });
  await processor.process({ update_id: 4, message: { text: "/status" } });
  await processor.process({ update_id: 3, callback_query: { data: "stale" } });
  assert.deepEqual(seen, ["a1:s:12:1", "/status"]);
  assert.deepEqual(offsets, [4, 5]);
  assert.equal(processor.getOffset(), 5);
  const db = new Database(":memory:");
  db.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const calls = [];
  assert.equal(await initializeOffset(db, async (method, body) => {
    calls.push([method, body]); return [{ update_id: 8 }];
  }), 9);
  assert.deepEqual(calls[0][1].allowed_updates, ["message", "callback_query"]);
  assert.equal(await initializeOffset(db, async () => { throw new Error("should not poll"); }), 9);
  db.close();
});

test("commands register only when changed and failures do not stop startup", async () => {
  const calls = [];
  const telegram = { call: async (method, body) => { calls.push([method, body]); return method === "getMyCommands" ? COMMANDS : true; } };
  await registerCommands(telegram, 42);
  assert.deepEqual(calls.map(c => c[0]), ["getMyCommands"]);
  assert.deepEqual(calls[0][1].scope, { type: "chat", chat_id: 42 });
  telegram.call = async (method, body) => { calls.push([method, body]); return method === "getMyCommands" ? [] : true; };
  await registerCommands(telegram, 42);
  assert.equal(calls.at(-1)[0], "setMyCommands");
  assert.deepEqual(calls.at(-1)[1].commands, COMMANDS);
  let logged = false;
  await registerCommands({ call: async () => { throw new Error("secret token"); } }, 42,
    { error: message => { logged = true; assert.doesNotMatch(message, /secret/); } });
  assert.equal(logged, true);
});

test("calendar toggle, explicit options, status, and help registry", async () => {
  const f = fixture();
  const message = text => ({ chat: { id: 42, type: "private" }, from: { id: 42 }, text });
  await handleMessage(message("/calendar_status"), f.runtime);
  assert.match(f.sent.at(-1)[1], /ENABLED/);
  await handleMessage(message("/calendar"), f.runtime);
  assert.match(f.sent.at(-1)[1], /DISABLED/);
  await handleMessage(message("/calendar status"), f.runtime);
  assert.match(f.sent.at(-1)[1], /DISABLED/);
  await handleMessage(message("/calendar on"), f.runtime);
  assert.match(f.sent.at(-1)[1], /ENABLED/);
  await handleMessage(message("/calendar off"), f.runtime);
  assert.match(f.sent.at(-1)[1], /DISABLED/);
  await handleMessage(message("/help"), f.runtime);
  for (const { command } of COMMANDS) assert.match(f.sent.at(-1)[1], new RegExp(`/${command} —`));
  f.db.close();
});

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { getActivityStatusOverride } = require("../src/activity-status");
const { filterPendingAssignments } = require("../src/activity-logic");
const { selectReminderCandidates } = require("../src/deadline-monitor");
const {
  COMMANDS, activityPage, createAssignmentCache, createUpdateProcessor, handleCallbackQuery,
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
    getAssignments: async () => assignments, getFreshAssignment: async assignment => assignment };
  const query = (data, from = 42, chat = 42) => ({ id: `q${answers.length}`, data,
    from: { id: from }, message: { message_id: 10, chat: { id: chat, type: "private" } } });
  return { db, assignments, sent, edits, answers, runtime, query };
}

test("paged pending selection, offline completion, dismissal, and restoration", async () => {
  const f = fixture();
  await handleMessage({ chat: { id: 42, type: "private" }, from: { id: 42 }, text: "/pending" }, f.runtime);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0][1], /Pending activities: 10/);
  assert.equal(f.sent[0][2].inline_keyboard.length, 7);
  assert.equal(f.sent[0][2].inline_keyboard.at(-2)[0].callback_data, "a1:l:p:1");
  assert.equal(f.sent[0][2].inline_keyboard.at(-1)[0].callback_data, "a1:f:p:0");
  await handleCallbackQuery(f.query("a1:l:p:1"), f.runtime);
  assert.match(f.edits.at(-1)[2], /Task 10/);
  await handleCallbackQuery(f.query("a1:s:12:1"), f.runtime);
  assert.match(f.edits.at(-1)[2], /Canvas submission: Not submitted/);
  assert.match(f.edits.at(-1)[2], /Guardian status: pending/);
  await handleCallbackQuery(f.query("a1:c:12:1"), f.runtime);
  assert.equal(getActivityStatusOverride(f.db, "12:1").status, "completed_offline");
  assert.match(f.edits.at(-1)[2], /Canvas was not changed/);
  await handleCallbackQuery(f.query("a1:c:12:1"), f.runtime);
  assert.match(f.edits.at(-1)[2], /Already in that status/);
  await handleCallbackQuery(f.query("a1:d:12:2"), f.runtime);
  assert.equal(getActivityStatusOverride(f.db, "12:2").status, "dismissed");
  await handleCallbackQuery(f.query("a1:c:12:2"), f.runtime);
  assert.equal(getActivityStatusOverride(f.db, "12:2").status, "dismissed");
  assert.match(f.edits.at(-1)[2], /status changed/);
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
  assert.match(f.edits.at(-1)[2], /Activity no longer found/);
  f.assignments[0].submitted = true;
  await handleCallbackQuery(f.query("a1:d:12:1"), f.runtime);
  assert.equal(getActivityStatusOverride(f.db, "12:1"), null);
  assert.match(f.edits.at(-1)[2], /Canvas status changed/);
  f.db.close();
});

test("valid callbacks acknowledge before a delayed Canvas response and report failures safely", async () => {
  const f = fixture();
  let release;
  f.runtime.getAssignments = () => new Promise(resolve => { release = resolve; });
  const pending = handleCallbackQuery(f.query("a1:d:12:1"), f.runtime);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.answers, [["q0", "Checking activity…"]]);
  assert.equal(getActivityStatusOverride(f.db, "12:1"), null);
  release(f.assignments);
  await pending;
  assert.equal(getActivityStatusOverride(f.db, "12:1").status, "dismissed");
  f.runtime.getAssignments = async () => { throw new Error("private Canvas details"); };
  await handleCallbackQuery(f.query("a1:s:12:1"), f.runtime);
  assert.equal(f.answers.length, 2);
  assert.match(f.edits.at(-1)[2], /Could not load activities/);
  assert.doesNotMatch(f.edits.at(-1)[2], /private Canvas/);
  f.db.close();
});

test("expired callback acknowledgments do not block authorized updates or later commands", async () => {
  const f = fixture();
  const warnings = [];
  f.runtime.logger = { warn: (message) => warnings.push(message) };
  f.runtime.telegram.answerCallbackQuery = async () => {
    throw new Error("query is too old");
  };
  const offsets = [];
  const processor = createUpdateProcessor(
    20,
    (message) => handleMessage(message, f.runtime),
    (offset) => offsets.push(offset),
    () => false,
    () => {},
    (query) => handleCallbackQuery(query, f.runtime)
  );
  await processor.process({ update_id: 20, callback_query: f.query("a1:d:12:1") });
  await processor.process({ update_id: 21, message: {
    chat: { id: 42, type: "private" }, from: { id: 42 }, text: "/status",
  } });
  assert.equal(getActivityStatusOverride(f.db, "12:1").status, "dismissed");
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0][1], /Monitoring:/);
  assert.deepEqual(offsets, [21, 22]);
  assert.equal(warnings.length, 1);

  // A failed acknowledgment for an unauthorized caller must never grant access.
  await processor.process({ update_id: 22, callback_query: f.query("a1:d:12:2", 77) });
  assert.equal(getActivityStatusOverride(f.db, "12:2"), null);
  assert.equal(warnings.length, 2);
  f.db.close();
});

test("callback persistence failures propagate and retain the polling offset", async () => {
  const f = fixture();
  const processor = createUpdateProcessor(30, async () => {}, () => {},
    () => false, () => {}, (query) => handleCallbackQuery(query, f.runtime));
  f.db.close();

  await assert.rejects(
    processor.process({ update_id: 30, callback_query: f.query("a1:d:12:1") }),
    /database connection is not open/
  );
  assert.equal(processor.getOffset(), 30);
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

test("five-item pages expose Refresh and details omit the redundant status button", async () => {
  const f = fixture();
  const first = activityPage(f.assignments, f.db, "p", 0);
  assert.match(first.text, /Page 1\/2/);
  assert.match(first.text, /Task 5/);
  assert.doesNotMatch(first.text, /Task 6/);
  assert.equal(first.markup.inline_keyboard.length, 7);
  assert.deepEqual(first.markup.inline_keyboard.at(-1), [
    { text: "🔄 Refresh from Canvas", callback_data: "a1:f:p:0" },
  ]);
  await handleCallbackQuery(f.query("a1:s:12:1"), f.runtime);
  const detailButtons = f.edits.at(-1)[3].inline_keyboard.flat().map(button => button.text);
  assert.equal(detailButtons.some(label => label.includes("View current status")), false);
  assert.equal(detailButtons.some(label => label.includes("Completed Offline")), true);
  assert.equal(detailButtons.some(label => label.includes("Dismiss")), true);
  f.db.close();
});

test("assignment cache reuses the snapshot for 60 seconds, accepts updates, and refreshes on demand", async () => {
  let now = 1000;
  let requests = 0;
  const cache = createAssignmentCache(
    async () => [{ key: "12:1", name: `Load ${++requests}` }],
    60_000, () => now
  );
  assert.equal((await cache.get())[0].name, "Load 1");
  now += 59_999;
  assert.equal((await cache.get())[0].name, "Load 1");
  assert.equal(requests, 1);
  cache.update({ key: "12:1", name: "Updated" });
  assert.equal((await cache.get())[0].name, "Updated");
  assert.equal((await cache.get({ force: true }))[0].name, "Load 2");
  now += 60_000;
  assert.equal((await cache.get())[0].name, "Load 3");
  assert.equal(requests, 3);
});

test("assignment cache shares in-flight loads and retries after a transient failure", async () => {
  let release;
  let requests = 0;
  const cache = createAssignmentCache(() => {
    requests += 1;
    if (requests === 1) return new Promise(resolve => { release = resolve; });
    if (requests === 2) return Promise.reject(new Error("Canvas offline"));
    return Promise.resolve([{ key: "12:1" }]);
  });
  const a = cache.get();
  const b = cache.get();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1);
  release([{ key: "12:2" }]);
  assert.deepEqual(await a, await b);
  await assert.rejects(cache.get({ force: true }), /Canvas offline/);
  assert.equal((await cache.get({ force: true }))[0].key, "12:1");
  assert.equal(requests, 3);
});

test("cached activity buttons avoid full Canvas reloads; refresh fetches again", async () => {
  const f = fixture();
  let listFetches = 0;
  f.runtime.assignmentCache = createAssignmentCache(async () => {
    listFetches += 1;
    return f.assignments.map(item => ({ ...item }));
  });
  const message = { chat: { id: 42, type: "private" }, from: { id: 42 }, text: "/pending" };
  await handleMessage(message, f.runtime);
  await handleCallbackQuery(f.query("a1:l:p:1"), f.runtime);
  await handleCallbackQuery(f.query("a1:s:12:1"), f.runtime);
  assert.equal(listFetches, 1);

  let targetedChecks = 0;
  f.runtime.getFreshAssignment = async assignment => {
    targetedChecks += 1;
    return { ...assignment, submitted: true };
  };
  await handleCallbackQuery(f.query("a1:d:12:1"), f.runtime);
  assert.equal(targetedChecks, 1);
  assert.equal(listFetches, 1);
  assert.equal(getActivityStatusOverride(f.db, "12:1"), null);
  assert.match(f.edits.at(-1)[2], /Canvas status changed/);

  await handleCallbackQuery(f.query("a1:f:p:0"), f.runtime);
  assert.equal(listFetches, 2);
  f.runtime.getFreshAssignment = async assignment => ({ ...assignment, submitted: false });
  await handleCallbackQuery(f.query("a1:c:12:1"), f.runtime);
  assert.equal(getActivityStatusOverride(f.db, "12:1").status, "completed_offline");
  assert.equal(listFetches, 2);
  f.db.close();
});

test("failed fresh Canvas verification never changes a Guardian status", async () => {
  const f = fixture();
  f.runtime.assignmentCache = createAssignmentCache(f.runtime.getAssignments);
  f.runtime.getFreshAssignment = async () => { throw new Error("Secret Canvas response"); };
  await handleCallbackQuery(f.query("a1:d:12:1"), f.runtime);
  assert.equal(getActivityStatusOverride(f.db, "12:1"), null);
  assert.match(f.edits.at(-1)[2], /Could not verify the activity with Canvas/);
  assert.doesNotMatch(f.edits.at(-1)[2], /Secret Canvas/);
  f.db.close();
});

test("today displays every due-today activity without pagination or a page counter", () => {
  const f = fixture();
  const now = new Date("2026-10-25T01:00:00Z");
  const today = activityPage(f.assignments, f.db, "t", 0, now);
  assert.match(today.text, /^📅 Due today: 10\n\n/);
  assert.doesNotMatch(today.text, /Page 1\/\d+/);
  assert.match(today.text, /10\. \[Art\] Task 10/);
  assert.equal(today.markup.inline_keyboard.length, 11);
  assert.equal(today.markup.inline_keyboard[9][0].callback_data, "a1:s:12:10");
  assert.deepEqual(today.markup.inline_keyboard.at(-1), [
    { text: "🔄 Refresh from Canvas", callback_data: "a1:f:t:0" },
  ]);
  const oldPage = activityPage(f.assignments, f.db, "t", 1, now);
  assert.deepEqual(oldPage, today);
  const empty = activityPage(f.assignments, f.db, "t", 0, new Date("2026-10-26T01:00:00Z"));
  assert.match(empty.text, /^📅 Due today: 0\n\nNo matching activities found\./);
  assert.doesNotMatch(empty.text, /Page \d+\/\d+/);
  f.db.close();
});

test("week puts the page counter above its heading and retains five-item pages", () => {
  const f = fixture();
  const now = new Date("2026-10-24T01:00:00Z");
  const first = activityPage(f.assignments, f.db, "w", 0, now);
  assert.match(first.text, /^Page 1\/2\n🗓 Due within 7 days: 10\n\n/);
  assert.match(first.text, /Task 5/);
  assert.doesNotMatch(first.text, /Task 6/);
  assert.equal(first.markup.inline_keyboard.length, 7);
  assert.equal(first.markup.inline_keyboard.at(-2)[0].callback_data, "a1:l:w:1");
  assert.equal(first.markup.inline_keyboard.at(-1)[0].callback_data, "a1:f:w:0");

  const second = activityPage(f.assignments, f.db, "w", 1, now);
  assert.match(second.text, /^Page 2\/2\n🗓 Due within 7 days: 10\n\n/);
  assert.match(second.text, /Task 6/);
  assert.match(second.text, /Task 10/);
  assert.doesNotMatch(second.text, /Task 5\n/);
  assert.equal(second.markup.inline_keyboard.at(-2)[0].callback_data, "a1:l:w:0");
  assert.equal(second.markup.inline_keyboard.at(-1)[0].callback_data, "a1:f:w:1");
  f.db.close();
});

test("large Today lists deliver every activity within Telegram limits", async () => {
  const f = fixture();
  f.assignments = Array.from({ length: 80 }, (_, index) => ({
    key: `12:${index + 1}`, id: String(index + 1), course: "Art",
    name: `Task ${index + 1} ${"long assignment title ".repeat(5)}`,
    dueAt: new Date().toISOString(), published: true, submitted: false, excused: false,
  }));
  f.runtime.getAssignments = async () => f.assignments;
  const page = activityPage(f.assignments, f.db, "t", 0);
  const parts = [page, ...page.additional];
  assert.ok(parts.length > 1);
  assert.equal(parts.reduce((count, part) => count + part.markup.inline_keyboard.length - 1, 0), 80);
  for (const part of parts) {
    assert.ok(part.text.length <= 4096);
    assert.ok(part.markup.inline_keyboard.length <= 100);
    assert.match(part.text, /Due today: 80/);
  }
  assert.deepEqual(parts.flatMap(part => part.markup.inline_keyboard.slice(0, -1).map(row => row[0].callback_data)),
    f.assignments.map(item => `a1:s:${item.key}`));
  await handleMessage({ chat: { id: 42, type: "private" }, from: { id: 42 }, text: "/today" }, f.runtime);
  assert.equal(f.sent.length, parts.length);
  assert.ok(f.sent.every(([, text]) => text.length <= 4096));
  f.db.close();
});

test("cached mutations propagate SQLite failures after fresh Canvas verification", async () => {
  const f = fixture();
  f.runtime.assignmentCache = createAssignmentCache(f.runtime.getAssignments);
  let verified = 0;
  f.runtime.getFreshAssignment = async assignment => { verified++; return assignment; };
  const processor = createUpdateProcessor(40, async () => {}, () => {},
    () => false, () => {}, query => handleCallbackQuery(query, f.runtime));
  f.db.close();
  await assert.rejects(processor.process({ update_id: 40,
    callback_query: f.query("a1:d:12:1") }), /database connection is not open/);
  assert.equal(verified, 1);
  assert.equal(processor.getOffset(), 40);
  assert.equal(f.edits.some(edit => /Dismissed\./.test(edit[2])), false);
});

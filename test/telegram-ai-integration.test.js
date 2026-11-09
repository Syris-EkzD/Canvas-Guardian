const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { handleMessage, handleCallbackQuery } = require("../src/telegram-bot");
const { stageSubmission, getRequest, stageSettingChange, getSettingChange } = require("../src/ai-workspace");
const { getCalendarSyncEnabled, getMonitoringState } = require("../src/monitoring-state");

function setup() {
  const db = new Database(":memory:");
  const sent = [];
  const answers = [];
  const telegram = {
    sendMessage: async (...args) => sent.push(args),
    answerCallbackQuery: async (...args) => answers.push(args),
    editMessageText: async () => {},
  };
  const runtime = {
    db, allowedChatId: 42, telegram, send: telegram.sendMessage,
    assistant: { talk: async () => "Simulated Gemini reply." },
  };
  const message = (chat, text) => ({
    chat: { id: chat, type: "private" }, from: { id: chat }, text,
  });
  const callback = (chat, data) => ({
    id: "cb-" + chat, data, from: { id: chat },
    message: { message_id: 1, chat: { id: chat, type: "private" } },
  });
  return { db, sent, answers, runtime, message, callback };
}

test("only the configured Telegram chat may talk to Gemini", async () => {
  const f = setup();
  await handleMessage(f.message(99, "what's due today?"), f.runtime);
  assert.equal(f.sent.length, 0);
  await handleMessage(f.message(42, "what's due today?"), f.runtime);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0][1], /Simulated Gemini reply/);
  f.db.close();
});

test("AI preview callbacks require chat authorization and a review before approval", async () => {
  const f = setup();
  const pending = await stageSubmission(f.db, 42, {
    courseId: "12", assignmentId: "34", submissionType: "online_text_entry",
    payload: "Exact approved text", advice: "Read carefully",
  }, { read: async () => ({
    id: 34, course_id: 12, published: true, name: "Essay",
    submission_types: ["online_text_entry"], submission: { workflow_state: "unsubmitted" },
  }) });
  await handleCallbackQuery(f.callback(99, "ai:r:" + pending.id), f.runtime);
  assert.equal(getRequest(f.db, 42, pending.id).status, "staged");
  assert.equal(f.sent.length, 0);
  await handleCallbackQuery(f.callback(42, "ai:r:" + pending.id), f.runtime);
  assert.equal(getRequest(f.db, 42, pending.id).status, "reviewed");
  assert.match(f.sent.at(-1)[1], /Exact approved text/);
  assert.equal(f.sent.at(-1)[2].inline_keyboard[0][0].callback_data, "ai:c:" + pending.id);
  await handleCallbackQuery(f.callback(42, "ai:x:" + pending.id), f.runtime);
  assert.equal(getRequest(f.db, 42, pending.id).status, "cancelled");
  f.db.close();
});

test("Gemini provider error details are not sent to user or propagated to logs", async () => {
  const f = setup();
  f.runtime.assistant.talk = async () => { throw new Error("private-api-key-and-student-data"); };
  await handleMessage(f.message(42, "help me draft"), f.runtime);
  assert.match(f.sent[0][1], /could not complete/);
  assert.doesNotMatch(f.sent[0][1], /private-api-key/);
  f.db.close();
});

test("Telegram settings approval requires verified sender and is single-use", async () => {
  const f = setup();
  const pending = stageSettingChange(f.db, 42, "monitoring", "paused");
  await handleCallbackQuery(f.callback(99, "gs:c:" + pending.id), f.runtime);
  assert.equal(getSettingChange(f.db, 42, pending.id).status, "pending");
  assert.equal(getMonitoringState(f.db), "running");
  await handleCallbackQuery(f.callback(42, "gs:c:" + pending.id), f.runtime);
  assert.equal(getMonitoringState(f.db), "paused");
  assert.equal(getSettingChange(f.db, 42, pending.id).status, "applied");
  await handleCallbackQuery(f.callback(42, "gs:c:" + pending.id), f.runtime);
  assert.equal(getSettingChange(f.db, 42, pending.id).status, "applied");
  assert.match(f.sent.at(-1)[1], /expired|already used/);
  f.db.close();
});

test("expired Telegram setting confirmations cannot change Calendar state", async () => {
  const f = setup();
  const old = stageSettingChange(f.db, 42, "calendar", "off", { now: 1 });
  assert.equal(getCalendarSyncEnabled(f.db), true);
  await handleCallbackQuery(f.callback(42, "gs:c:" + old.id), f.runtime);
  assert.equal(getCalendarSyncEnabled(f.db), true);
  assert.equal(getSettingChange(f.db, 42, old.id).status, "pending");
  f.db.close();
});

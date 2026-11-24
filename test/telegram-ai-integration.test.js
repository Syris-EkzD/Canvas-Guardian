const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { handleMessage, handleCallbackQuery, sendAiSubmissionPreview } = require("../src/telegram-bot");
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
    id: 34, course_id: 12, published: true, can_submit: true, name: "Essay",
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

test("setting callback verifies the Telegram sender separately from the authorized chat", async () => {
  const f = setup();
  const pending = stageSettingChange(f.db, 42, "monitoring", "paused");
  const forged = f.callback(42, "gs:c:" + pending.id);
  forged.from.id = 99;
  await handleCallbackQuery(forged, f.runtime);
  assert.equal(getSettingChange(f.db, 42, pending.id).status, "pending");
  assert.equal(getMonitoringState(f.db), "running");
  f.db.close();
});

test("submission preview and full review identify Canvas destination and preserve the full payload", async () => {
  const f = setup();
  const content = "Exact work from History class < & >".repeat(120);
  const pending = await stageSubmission(f.db, 42, {
    courseId: "12", assignmentId: "34", submissionType: "online_text_entry",
    payload: content, gaps: ["Add a bibliography"], advice: "Check citations",
  }, { read: async () => ({
    id: 34, course_id: 12, name: "Essay", course_name: "History",
    html_url: "https://canvas.example.edu/courses/12/assignments/34",
    published: true, can_submit: true, locked_for_user: false,
    submission_types: ["online_text_entry", "online_url"],
    submission: { workflow_state: "unsubmitted" },
  }) });
  await sendAiSubmissionPreview(f.runtime.send, 42, pending);
  assert.match(f.sent[0][1], /Course: History \(ID 12\)/);
  assert.match(f.sent[0][1], /Assignment: Essay \(ID 34\)/);
  assert.match(f.sent[0][1], /Canvas assignment URL: https:\/\/canvas\.example\.edu\/courses\/12\/assignments\/34/);
  assert.match(f.sent[0][1], /Accepted submission types: online_text_entry, online_url/);
  assert.match(f.sent[0][1], /Selected submission type: online_text_entry/);
  assert.match(f.sent[0][1], /Identified gaps: Add a bibliography/);
  assert.match(f.sent[0][1], /Recommendation: Check citations/);

  await handleCallbackQuery(f.callback(42, "ai:r:" + pending.id), f.runtime);
  assert.equal(getRequest(f.db, 42, pending.id).status, "reviewed");
  assert.match(f.sent[1][1], /Course: History \(ID 12\)/);
  assert.match(f.sent[1][1], /Assignment: Essay \(ID 34\)/);
  assert.match(f.sent[1][1], /Canvas assignment URL:/);
  assert.match(f.sent[1][1], /Accepted submission types:/);
  assert.match(f.sent[1][1], /Identified gaps: Add a bibliography/);
  assert.equal(f.sent.slice(2).map(x => x[1]).join(""), content);
  assert.equal(f.sent.at(-1)[2].inline_keyboard[0][0].callback_data, "ai:c:" + pending.id);
  f.db.close();
});


test("long review metadata is delivered without truncation or early approval buttons", async () => {
  const f = setup();
  const limitedSend = async (...args) => {
    if (args[1].length > 4096) throw new Error("Mock Telegram: message is too long");
    f.sent.push(args);
  };
  f.runtime.send = limitedSend;
  f.runtime.telegram.sendMessage = limitedSend;

  const gaps = Array.from({ length: 20 }, (_, i) =>
    "Gap " + (i + 1) + ": " + "g".repeat(489));
  const payload = "A".repeat(3499) + "😀" + "B".repeat(7000);
  const pending = await stageSubmission(f.db, 42, {
    courseId: "12", assignmentId: "34", submissionType: "online_text_entry",
    payload, gaps, advice: "Verify the entire submitted text.",
  }, { read: async () => ({
    id: 34, course_id: 12, name: "Practice Essay", course_name: "History",
    published: true, can_submit: true, submission_types: ["online_text_entry"],
    submission: { workflow_state: "unsubmitted" },
  }) });

  await sendAiSubmissionPreview(f.runtime.send, 42, pending);
  const previewMessages = f.sent.slice();
  assert.ok(previewMessages.length > 1);
  assert.ok(previewMessages.every(([, text]) => text.length <= 4096));
  assert.ok(previewMessages.slice(0, -1).every(([, , markup]) => !markup));
  assert.equal(previewMessages.at(-1)[2].inline_keyboard[0][0].callback_data, "ai:r:" + pending.id);
  const previewText = previewMessages.map(([, text]) => text).join("");
  assert.ok(previewText.includes(gaps.join("; ")));
  assert.match(previewText, /Course: History \(ID 12\)/);
  assert.match(previewText, /Recommendation: Verify the entire submitted text/);

  await handleCallbackQuery(f.callback(42, "ai:r:" + pending.id), f.runtime);
  const reviewMessages = f.sent.slice(previewMessages.length);
  assert.ok(reviewMessages.length > 2);
  assert.ok(reviewMessages.every(([, text]) => text.length <= 4096));
  assert.ok(reviewMessages.slice(0, -1).every(([, , markup]) => !markup));
  assert.equal(reviewMessages.at(-1)[2].inline_keyboard[0][0].callback_data, "ai:c:" + pending.id);
  const payloadStart = reviewMessages.findIndex(([, text]) => text.startsWith("A".repeat(100)));
  assert.ok(payloadStart > 0);
  const header = reviewMessages.slice(0, payloadStart).map(([, text]) => text).join("");
  const deliveredPayload = reviewMessages.slice(payloadStart).map(([, text]) => text).join("");
  assert.ok(header.includes(gaps.join("; ")));
  assert.match(header, /Assignment: Practice Essay \(ID 34\)/);
  assert.match(header, /Recommendation: Verify the entire submitted text/);
  assert.equal(deliveredPayload, payload);
  assert.equal(getRequest(f.db, 42, pending.id).status, "reviewed");
  f.db.close();
});

test("failed review metadata or final confirmation delivery cancels the approval", async () => {
  for (const failAt of ["header", "confirmation"]) {
    const f = setup();
    let rejected = false;
    const limitedSend = async (...args) => {
      const [, text, markup] = args;
      if (text.length > 4096) throw new Error("Mock Telegram: message is too long");
      const confirms = markup?.inline_keyboard?.flat().some(
        button => button.callback_data?.startsWith("ai:c:"));
      if (!rejected && (failAt === "header" && text.startsWith("FULL SUBMISSION REVIEW") ||
          failAt === "confirmation" && confirms)) {
        rejected = true;
        throw new Error("Mock Telegram delivery failed");
      }
      f.sent.push(args);
    };
    f.runtime.telegram.sendMessage = limitedSend;
    const pending = await stageSubmission(f.db, 42, {
      courseId: "12", assignmentId: "34", submissionType: "online_text_entry",
      payload: "Checked payload " + "x".repeat(7000), gaps: ["Check evidence"],
    }, { read: async () => ({
      id: 34, course_id: 12, name: "Practice Essay", published: true, can_submit: true,
      submission_types: ["online_text_entry"],
      submission: { workflow_state: "unsubmitted" },
    }) });
    await handleCallbackQuery(f.callback(42, "ai:r:" + pending.id), f.runtime);
    assert.equal(rejected, true, failAt + " was exercised");
    assert.equal(getRequest(f.db, 42, pending.id).status, "cancelled");
    assert.ok(f.sent.every(([, , markup]) => !markup?.inline_keyboard?.flat().some(
      button => button.callback_data === "ai:c:" + pending.id)));
    assert.match(f.sent.at(-1)[1], /Submission review delivery failed; preview cancelled/);
    await handleCallbackQuery(f.callback(42, "ai:c:" + pending.id), f.runtime);
    assert.equal(getRequest(f.db, 42, pending.id).status, "cancelled");
    f.db.close();
  }
});

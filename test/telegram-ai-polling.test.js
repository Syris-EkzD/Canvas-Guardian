const test = require("node:test");
const assert = require("node:assert/strict");
const { createUpdateProcessor, isAuthorizedAiMessage, handleMessage } = require("../src/telegram-bot");

const makeMessage = (chatId, text, fromId = chatId) => ({
  chat: { id: chatId, type: "private" }, from: { id: fromId }, text,
});
const tick = () => new Promise(resolve => setImmediate(resolve));

test("slow AI does not block commands, callbacks or polling offsets; overlapping AI gets feedback", async () => {
  let finish;
  const slow = new Promise(resolve => { finish = resolve; });
  const calls = [], offsets = [], busy = [];
  const processor = createUpdateProcessor(
    10,
    async message => { calls.push(message.text); if (message.text === "AI first") await slow; },
    offset => offsets.push(offset),
    () => false,
    error => { throw error; },
    async query => calls.push("callback:" + query.data),
    {
      isAiMessage: message => message.text.startsWith("AI"),
      onAiBusy: async message => busy.push(message.text),
    }
  );
  await processor.process({ update_id: 10, message: makeMessage(42, "AI first") });
  await tick();
  assert.equal(processor.isAiBusy(42), true);
  await processor.process({ update_id: 11, callback_query: { data: "ai:x:pending-id" } });
  await processor.process({ update_id: 12, message: makeMessage(42, "/status") });
  await processor.process({ update_id: 13, message: makeMessage(42, "AI second") });
  await tick();
  assert.deepEqual(calls, ["AI first", "callback:ai:x:pending-id", "/status"]);
  assert.deepEqual(busy, ["AI second"]);
  assert.deepEqual(offsets, [11, 12, 13, 14]);
  assert.equal(processor.getOffset(), 14);
  finish();
  await tick();
  assert.equal(processor.isAiBusy(42), false);
  await processor.process({ update_id: 14, message: makeMessage(42, "AI third") });
  await tick();
  assert.ok(calls.includes("AI third"));
  assert.equal(processor.getOffset(), 15);
});

test("AI background failure does not terminate polling or leak provider error details", async () => {
  const errors = [], offsets = [], handled = [];
  const processor = createUpdateProcessor(1,
    async message => {
      handled.push(message.text);
      if (message.text === "AI fail") throw new Error("gemini-secret-and-private-student-data");
    },
    offset => offsets.push(offset), () => false, error => errors.push(error.message),
    async () => {},
    { isAiMessage: message => message.text.startsWith("AI"),
      onAiBusy: async () => { throw new Error("private-busy-notice-failure"); } }
  );
  await processor.process({ update_id: 1, message: makeMessage(42, "AI fail") });
  await tick();
  await processor.process({ update_id: 2, message: makeMessage(42, "/status") });
  assert.deepEqual(handled, ["AI fail", "/status"]);
  assert.deepEqual(offsets, [2, 3]);
  assert.deepEqual(errors, ["AI background request failed"]);
  assert.equal(processor.isAiBusy(42), false);
});

test("AI message classification requires an authorized private chat", () => {
  const allowed = 42;
  assert.equal(isAuthorizedAiMessage(makeMessage(42, "draft my assignment"), allowed), true);
  assert.equal(isAuthorizedAiMessage(makeMessage(42, "/ai help"), allowed), true);
  assert.equal(isAuthorizedAiMessage(makeMessage(42, "/draft 12 34"), allowed), true);
  assert.equal(isAuthorizedAiMessage(makeMessage(42, "/status"), allowed), false);
  assert.equal(isAuthorizedAiMessage(makeMessage(42, "/forget"), allowed), false);
  assert.equal(isAuthorizedAiMessage(makeMessage(42, "/pending"), allowed), false);
  assert.equal(isAuthorizedAiMessage(makeMessage(42, "AI message", 99), allowed), false);
  assert.equal(isAuthorizedAiMessage(makeMessage(99, "AI message"), allowed), false);
});

test("forget does not race with an active AI response", async () => {
  const sent = [];
  const runtime = {
    db: {}, allowedChatId: 42, isAiBusy: () => true,
    send: async (...args) => sent.push(args),
  };
  await handleMessage(makeMessage(42, "/forget"), runtime);
  assert.match(sent.at(-1)[1], /still running/);
});

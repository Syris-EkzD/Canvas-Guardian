const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createTelegramClient } = require("../src/telegram-client");

test("sendMessage posts the expected Telegram request", async () => {
  let request;

  const client = createTelegramClient("fake-telegram-token", async (url, options) => {
    request = { url, options };

    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: { message_id: 7 },
      }),
    };
  });

  const result = await client.sendMessage("fake-chat-id", "hello");

  assert.deepEqual(result, { message_id: 7 });
  assert.equal(
    request.url,
    "https://api.telegram.org/botfake-telegram-token/sendMessage"
  );
  assert.equal(request.options.method, "POST");
  assert.deepEqual(JSON.parse(request.options.body), {
    chat_id: "fake-chat-id",
    text: "hello",
    disable_web_page_preview: true,
  });
});

test("reports Telegram HTTP failures", async () => {
  const client = createTelegramClient("fake-telegram-token", async () => ({
    ok: false,
    status: 502,
    json: async () => ({ ok: false }),
  }));

  await assert.rejects(
    client.call("getUpdates", { timeout: 0 }),
    new Error("Telegram returned HTTP 502")
  );
});

test("reports Telegram API error payloads even when HTTP succeeds", async () => {
  const client = createTelegramClient("fake-telegram-token", async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: false,
      description: "Bad Request: chat not found",
    }),
  }));

  await assert.rejects(
    client.sendMessage("fake-chat-id", "hello"),
    new Error("Bad Request: chat not found")
  );
});

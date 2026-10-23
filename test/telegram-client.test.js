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
  assert.ok(request.options.signal instanceof AbortSignal);
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

test("downloads a bounded file from Telegram getFile", async () => {
  const urls = [];
  const client = createTelegramClient("fake-token", async (url) => {
    urls.push(url);
    if (url.endsWith("/getFile")) return { ok: true, json: async () => ({ ok: true, result: { file_path: "documents/file_1.csv", file_size: 3 } }) };
    return { ok: true, headers: new Headers(), body: new Response("abc").body };
  });
  assert.equal((await client.downloadFile("id", 5)).toString(), "abc");
  assert.equal(urls[1], "https://api.telegram.org/file/botfake-token/documents/file_1.csv");
});

test("rejects oversized streams and unsafe Telegram file paths", async () => {
  let downloadCount = 0;
  const client = createTelegramClient("fake-token", async (url) => {
    if (url.endsWith("/getFile")) return { ok: true, json: async () => ({ ok: true, result: { file_path: "documents/file.csv" } }) };
    downloadCount += 1;
    return { ok: true, headers: new Headers(), body: new Response("too long").body };
  });
  await assert.rejects(client.downloadFile("id", 3), /size limit/);
  assert.equal(downloadCount, 1);
  const unsafe = createTelegramClient("fake-token", async () => ({ ok: true, json: async () => ({ ok: true, result: { file_path: "../secret" } }) }));
  await assert.rejects(unsafe.downloadFile("id", 5), /invalid file path/);
});

test("sendDocument uploads workbook bytes as multipart and reports delivery errors", async () => {
  let request;
  const client = createTelegramClient("fake-token", async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 9 } }) };
  });
  assert.deepEqual(await client.sendDocument(42, Buffer.from("xlsx")), { message_id: 9 });
  assert.equal(request.url, "https://api.telegram.org/botfake-token/sendDocument");
  assert.equal(request.options.body.get("chat_id"), "42");
  assert.equal(await request.options.body.get("document").text(), "xlsx");
  assert.equal(request.options.body.get("document").name, "academic-report.xlsx");
  assert.ok(request.options.signal instanceof AbortSignal);
  const failing = createTelegramClient("fake-token", async () => ({ ok: false, json: async () => ({ ok: false }) }));
  await assert.rejects(failing.sendDocument(42, Buffer.from("xlsx")), /delivery failed/);
});

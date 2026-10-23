function createTelegramClient(botToken, fetchImpl = global.fetch) {
  const telegramUrl = `https://api.telegram.org/bot${botToken}`;
  const fileUrl = `https://api.telegram.org/file/bot${botToken}/`;

  function requestSignal(signal, timeoutMs) {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  async function call(method, body, signal) {
    const response = await fetchImpl(`${telegramUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: requestSignal(signal, 45_000),
    });

    let result;

    try {
      result = await response.json();
    } catch {
      if (!response.ok) {
        throw new Error(`Telegram returned HTTP ${response.status}`);
      }

      throw new Error("Telegram returned invalid JSON");
    }

    if (!response.ok || !result.ok) {
      throw new Error(
        result.description || `Telegram returned HTTP ${response.status}`
      );
    }

    return result.result;
  }

  function sendMessage(chatId, text, replyMarkup) {
    return call("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  function editMessageText(chatId, messageId, text, replyMarkup) {
    return call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      reply_markup: replyMarkup,
    });
  }

  function answerCallbackQuery(callbackQueryId, text) {
    return call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  async function downloadFile(fileId, maxBytes, signal) {
    const file = await call("getFile", { file_id: fileId }, signal);
    if (Number.isFinite(file.file_size) && file.file_size > maxBytes) {
      throw new Error("CSV exceeds the configured size limit");
    }
    if (typeof file.file_path !== "string" ||
        !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(file.file_path) ||
        file.file_path.split("/").some((part) => part === "." || part === "..")) {
      throw new Error("Telegram returned an invalid file path");
    }

    const response = await fetchImpl(`${fileUrl}${file.file_path}`, {
      redirect: "error",
      signal: requestSignal(signal, 60_000),
    });
    if (!response.ok || !response.body) {
      throw new Error("Telegram file download failed");
    }
    const declaredLength = Number(response.headers?.get("content-length"));
    if (declaredLength > maxBytes) {
      await response.body.cancel();
      throw new Error("CSV exceeds the configured size limit");
    }

    const chunks = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error("CSV exceeds the configured size limit");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, size);
  }

  async function sendDocument(chatId, buffer, filename = "academic-report.xlsx", signal) {
    if (!Buffer.isBuffer(buffer) || buffer.length > 50 * 1000 * 1000) {
      throw new Error("Report exceeds the Telegram document size limit");
    }
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("document", new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }), filename);
    const response = await fetchImpl(`${telegramUrl}/sendDocument`, {
      method: "POST",
      body: form,
      signal: requestSignal(signal, 60_000),
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error("Telegram document delivery failed");
    }
    if (!response.ok || !result.ok) {
      throw new Error("Telegram document delivery failed");
    }
    return result.result;
  }

  return { answerCallbackQuery, call, downloadFile, editMessageText, sendDocument, sendMessage };
}

module.exports = { createTelegramClient };

function createTelegramClient(botToken, fetchImpl = global.fetch) {
  const telegramUrl = `https://api.telegram.org/bot${botToken}`;

  async function call(method, body) {
    const response = await fetchImpl(`${telegramUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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

  function sendMessage(chatId, text) {
    return call("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    });
  }

  return { call, sendMessage };
}

module.exports = { createTelegramClient };

require("dotenv").config();

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is missing from .env");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/getUpdates`
  );

  if (!response.ok) {
    throw new Error(`Telegram returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  const chats = new Map();

  for (const update of payload.result) {
    const chat = update.message?.chat;

    if (chat?.type === "private") {
      chats.set(chat.id, {
        chatId: chat.id,
        username: chat.username || "(no username)",
        name: [chat.first_name, chat.last_name].filter(Boolean).join(" "),
      });
    }
  }

  if (chats.size === 0) {
    console.log("No private chat found. Open the bot and send /start, then run this again.");
    return;
  }

  console.table([...chats.values()]);
}

main().catch((error) => {
  console.error("Could not get Telegram updates:", error.message);
  process.exit(1);
});

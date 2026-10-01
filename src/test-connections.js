require("dotenv").config();

const { canvasGet } = require("./canvas-client");

const {
  CANVAS_BASE_URL,
  CANVAS_ACCESS_TOKEN,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_ALLOWED_CHAT_ID,
} = process.env;

function requireSetting(name, value) {
  if (!value) {
    throw new Error(`${name} is missing from .env`);
  }
}

async function getCanvasProfile() {
  return canvasGet("/api/v1/users/self/profile");
}

async function sendTelegramMessage(text) {
  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_ALLOWED_CHAT_ID,
        text,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Telegram returned HTTP ${response.status}`);
  }
}

async function main() {
  requireSetting("CANVAS_BASE_URL", CANVAS_BASE_URL);
  requireSetting("CANVAS_ACCESS_TOKEN", CANVAS_ACCESS_TOKEN);
  requireSetting("TELEGRAM_BOT_TOKEN", TELEGRAM_BOT_TOKEN);
  requireSetting("TELEGRAM_ALLOWED_CHAT_ID", TELEGRAM_ALLOWED_CHAT_ID);

  const profile = await getCanvasProfile();

  console.log(`Canvas connected as: ${profile.name}`);

  await sendTelegramMessage(
    "✅ Horus Canvas Guardian beta is connected to Canvas and Telegram."
  );

  console.log("Telegram test message sent.");
}

main().catch((error) => {
  console.error("Connection test failed:", error.message);
  process.exit(1);
});

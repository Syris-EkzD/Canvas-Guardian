require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const projectRoot = path.join(__dirname, "..");

const credentialsPath = path.join(
  projectRoot,
  "secrets",
  "google-oauth-credentials.json"
);

const tokenPath = path.join(
  projectRoot,
  "secrets",
  "google-oauth-token.json"
);

const credentials = JSON.parse(
  fs.readFileSync(credentialsPath, "utf8")
);

const token = JSON.parse(
  fs.readFileSync(tokenPath, "utf8")
);

const client = credentials.installed;

const auth = new google.auth.OAuth2(
  client.client_id,
  client.client_secret,
  client.redirect_uris?.[0]
);

auth.setCredentials(token);

const calendar = google.calendar({
  version: "v3",
  auth,
});

async function main() {
  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  if (!calendarId) {
    throw new Error("GOOGLE_CALENDAR_ID is missing from .env");
  }

  const start = new Date(Date.now() + 10 * 60 * 1000);
  const end = new Date(start.getTime() + 15 * 60 * 1000);

  await calendar.events.insert({
    calendarId,
    requestBody: {
      summary: "🧪 Horus Calendar Connection Test",
      description:
        "Temporary event created by Horus to verify Google and Samsung Calendar synchronization.",
      start: {
        dateTime: start.toISOString(),
        timeZone: "Asia/Manila",
      },
      end: {
        dateTime: end.toISOString(),
        timeZone: "Asia/Manila",
      },
      reminders: {
        useDefault: false,
      },
      extendedProperties: {
        private: {
          managedBy: "horus",
          eventType: "connection_test",
        },
      },
    },
  });

  console.log("Google Calendar connected.");
  console.log(
    "Test event created for:",
    start.toLocaleString("en-PH", {
      timeZone: "Asia/Manila",
      dateStyle: "medium",
      timeStyle: "short",
    })
  );
}

main().catch((error) => {
  console.error(
    "Google Calendar test failed:",
    error.response?.data?.error?.message || error.message
  );

  process.exit(1);
});

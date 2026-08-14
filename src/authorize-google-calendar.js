const fs = require("fs");
const http = require("http");
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

const scope =
  "https://www.googleapis.com/auth/calendar.events.owned";

const redirectUri =
  "http://127.0.0.1:3000/oauth2callback";

const credentials = JSON.parse(
  fs.readFileSync(credentialsPath, "utf8")
);

const client = credentials.installed;

if (!client?.client_id || !client?.client_secret) {
  throw new Error(
    "The credentials file does not contain Desktop app credentials."
  );
}

const oauth2Client = new google.auth.OAuth2(
  client.client_id,
  client.client_secret,
  redirectUri
);

const authorizationUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: [scope],
});

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, redirectUri);

  if (requestUrl.pathname !== "/oauth2callback") {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  const authorizationError = requestUrl.searchParams.get("error");
  const authorizationCode = requestUrl.searchParams.get("code");

  if (authorizationError) {
    response.writeHead(400);
    response.end(`Authorization failed: ${authorizationError}`);
    console.error(`Google authorization failed: ${authorizationError}`);
    server.close();
    return;
  }

  if (!authorizationCode) {
    response.writeHead(400);
    response.end("Missing authorization code.");
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(authorizationCode);

    fs.writeFileSync(
      tokenPath,
      JSON.stringify(tokens, null, 2),
      { mode: 0o600 }
    );

    fs.chmodSync(tokenPath, 0o600);

    response.writeHead(200, {
      "Content-Type": "text/plain",
    });

    response.end(
      "Horus Google Calendar authorization succeeded. You may close this tab."
    );

    console.log(`Authorization token saved to: ${tokenPath}`);
    server.close();
  } catch (error) {
    response.writeHead(500);
    response.end("Token exchange failed.");

    console.error("Token exchange failed:", error.message);
    server.close();
  }
});

server.listen(3000, "127.0.0.1", () => {
  console.log("Waiting for Google Calendar authorization.");
  console.log("");
  console.log("Open this URL in your laptop browser:");
  console.log("");
  console.log(authorizationUrl);
});

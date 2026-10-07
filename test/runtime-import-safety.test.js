const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const runtimeModules = [
  "../src/activity-monitor",
  "../src/announcement-monitor",
  "../src/deadline-monitor",
  "../src/telegram-bot",
  "../src/calendar-sync",
];

const runtimeEnvironment = [
  "CANVAS_BASE_URL",
  "CANVAS_ACCESS_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_CHAT_ID",
  "GOOGLE_CALENDAR_ID",
];

test("runtime modules are safe to import without starting production services", () => {
  const originalLoad = Module._load;
  const originalFetch = global.fetch;
  const originalEnvironment = Object.fromEntries(
    runtimeEnvironment.map((name) => [name, process.env[name]])
  );

  let databaseOpened = false;
  let googleClientAccessed = false;
  let networkRequested = false;

  for (const name of runtimeEnvironment) {
    delete process.env[name];
  }

  Module._load = function loadWithoutRuntimeSideEffects(
    request,
    parent,
    isMain
  ) {
    if (request === "better-sqlite3") {
      return function UnexpectedDatabaseOpen() {
        databaseOpened = true;
        throw new Error("Runtime import attempted to open SQLite");
      };
    }

    if (request === "googleapis") {
      return {
        google: new Proxy(
          {},
          {
            get() {
              googleClientAccessed = true;
              throw new Error(
                "Runtime import attempted to initialize Google Calendar"
              );
            },
          }
        ),
      };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  global.fetch = async () => {
    networkRequested = true;
    throw new Error("Runtime import attempted a network request");
  };

  try {
    for (const modulePath of runtimeModules) {
      delete require.cache[require.resolve(modulePath)];

      assert.doesNotThrow(
        () => require(modulePath),
        `${modulePath} should be import-safe`
      );
    }

    assert.equal(databaseOpened, false);
    assert.equal(googleClientAccessed, false);
    assert.equal(networkRequested, false);
  } finally {
    Module._load = originalLoad;
    global.fetch = originalFetch;

    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }

    for (const modulePath of runtimeModules) {
      delete require.cache[require.resolve(modulePath)];
    }
  }
});

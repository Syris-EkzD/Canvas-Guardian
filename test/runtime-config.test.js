const { test } = require("node:test");
const assert = require("node:assert/strict");

const { requireEnvironment } = require("../src/runtime-config");

test("returns only the required configuration values", () => {
  const result = requireEnvironment(
    ["CANVAS_BASE_URL", "CANVAS_ACCESS_TOKEN"],
    {
      CANVAS_BASE_URL: "https://canvas.example.edu",
      CANVAS_ACCESS_TOKEN: "fake-canvas-token",
      UNRELATED: "ignored",
    }
  );

  assert.deepEqual(result, {
    CANVAS_BASE_URL: "https://canvas.example.edu",
    CANVAS_ACCESS_TOKEN: "fake-canvas-token",
  });
});

test("reports missing required variables without exposing values", () => {
  assert.throws(
    () =>
      requireEnvironment(
        ["CANVAS_BASE_URL", "TELEGRAM_BOT_TOKEN"],
        { CANVAS_BASE_URL: "https://canvas.example.edu" }
      ),
    new Error("Missing required environment variable: TELEGRAM_BOT_TOKEN")
  );

  assert.throws(
    () => requireEnvironment(["ONE", "TWO"], {}),
    new Error("Missing required environment variables: ONE, TWO")
  );
});

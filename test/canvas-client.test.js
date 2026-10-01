const { afterEach, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");

const { canvasGet, canvasGetAll } = require("../src/canvas-client");

const baseUrl = "https://canvas.example.edu";
const accessToken = "test-access-token";

let originalFetch;
let originalBaseUrl;
let originalAccessToken;

function restoreEnvironment(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

beforeEach(() => {
  originalFetch = global.fetch;
  originalBaseUrl = process.env.CANVAS_BASE_URL;
  originalAccessToken = process.env.CANVAS_ACCESS_TOKEN;
  process.env.CANVAS_BASE_URL = baseUrl;
  process.env.CANVAS_ACCESS_TOKEN = accessToken;
});

afterEach(() => {
  global.fetch = originalFetch;
  restoreEnvironment("CANVAS_BASE_URL", originalBaseUrl);
  restoreEnvironment("CANVAS_ACCESS_TOKEN", originalAccessToken);
});

test("canvasGet constructs the URL, authorizes, and returns JSON", async () => {
  const expected = { id: 42, name: "Example" };
  let request;

  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => expected,
    };
  };

  const result = await canvasGet("/api/v1/example");

  assert.equal(request.url, `${baseUrl}/api/v1/example`);
  assert.equal(
    request.options.headers.Authorization,
    `Bearer ${accessToken}`
  );
  assert.strictEqual(result, expected);
});

test("canvasGet preserves the Canvas HTTP error", async () => {
  global.fetch = async () => ({ ok: false, status: 401 });

  await assert.rejects(
    canvasGet("/api/v1/example"),
    new Error("Canvas returned HTTP 401")
  );
});

test("canvasGetAll follows only rel=next and preserves page order", async () => {
  const requests = [];
  const secondPageUrl = `${baseUrl}/api/v1/example?page=2`;

  global.fetch = async (url, options) => {
    requests.push({ url, options });

    if (url === `${baseUrl}/api/v1/example`) {
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: 1 }, { id: 2 }],
        headers: {
          get: (name) =>
            name === "link"
              ? `<${baseUrl}/api/v1/example?page=1>; rel="current", <${secondPageUrl}>; rel="next", <${baseUrl}/api/v1/example?page=8>; rel="last"`
              : null,
        },
      };
    }

    assert.equal(url, secondPageUrl);
    return {
      ok: true,
      status: 200,
      json: async () => [{ id: 3 }],
      headers: {
        get: (name) =>
          name === "link"
            ? `<${baseUrl}/api/v1/example?page=1>; rel="first", <${secondPageUrl}>; rel="current", <${baseUrl}/api/v1/example?page=8>; rel="last"`
            : null,
      },
    };
  };

  const result = await canvasGetAll("/api/v1/example");

  assert.deepEqual(result, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.deepEqual(
    requests.map((request) => request.url),
    [`${baseUrl}/api/v1/example`, secondPageUrl]
  );

  for (const request of requests) {
    assert.equal(
      request.options.headers.Authorization,
      `Bearer ${accessToken}`
    );
  }
});

test("canvasGetAll preserves the Canvas HTTP error", async () => {
  global.fetch = async () => ({ ok: false, status: 503 });

  await assert.rejects(
    canvasGetAll("/api/v1/example"),
    new Error("Canvas returned HTTP 503")
  );
});

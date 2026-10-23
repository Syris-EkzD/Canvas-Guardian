const test = require("node:test");
const assert = require("node:assert/strict");
const { getAssignmentDraftContext } = require("../src/assignment-draft-context");
const { generateAssignmentDraft, reviseAssignmentDraft } = require("../src/gemini-draft-engine");

const context = {
  courseId: "12", assignmentId: "34", title: "Essay", description: "Discuss the topic",
  dueAt: null, submissionTypes: ["online_text_entry"], allowedExtensions: [],
  pointsPossible: 10, rubric: [{ description: "Argument", details: "Clear thesis", points: 10 }],
  url: "https://canvas.example/courses/12/assignments/34",
};
const result = { draft: "A working thesis...", explanation: "Addresses the argument criterion.", gaps: ["Add cited evidence."] };

test("reads only the selected assignment and extracts HTML and rubric", async () => {
  const paths = [];
  const value = await getAssignmentDraftContext(12, 34, {
    canvasRequest: async (path) => {
      paths.push(path);
      return {
        id: 34, course_id: 12, name: "Essay", description: "<p>Write a <strong>thesis</strong> &amp; <a href='https://example.com'>cite sources</a>.</p>",
        due_at: "2026-11-01T12:00:00Z", submission_types: ["online_text_entry"],
        allowed_extensions: ["docx"], points_possible: 15,
        rubric: [{ description: "Argument", long_description: "<p>Clear <b>thesis</b></p>", points: 10 }],
        html_url: "https://canvas.example/courses/12/assignments/34",
      };
    },
  });
  assert.deepEqual(paths, ["/api/v1/courses/12/assignments/34"]);
  assert.match(value.description, /thesis & cite sources/);
  assert.deepEqual(value.rubric, [{ description: "Argument", details: "Clear thesis", points: 10 }]);
  assert.equal(value.dueAt, "2026-11-01T12:00:00Z");
  assert.deepEqual(value.allowedExtensions, ["docx"]);
});

test("missing description and rubric stay missing; mismatched IDs fail", async () => {
  const value = await getAssignmentDraftContext("12", "34", {
    canvasRequest: async () => ({ id: 34, name: "Essay", description: null }),
  });
  assert.equal(value.description, null);
  assert.deepEqual(value.rubric, []);
  await assert.rejects(getAssignmentDraftContext("12/evil", "34", { canvasRequest: () => { throw Error("network"); } }), /positive Canvas ID/);
  await assert.rejects(getAssignmentDraftContext(12, 34, { canvasRequest: async () => ({ id: 35 }) }), /different assignment/);
});

test("generates and revises with only whitelisted context and bounded SDK options", async () => {
  const calls = [];
  const client = { models: { generateContent: async (request) => {
    calls.push(request);
    return { text: JSON.stringify(result), candidates: [{ finishReason: "STOP" }] };
  } } };
  const extra = { ...context, canvasToken: "secret-canvas-token", rubric: [{ ...context.rubric[0], hiddenToken: "secret-rubric-token" }] };
  assert.deepEqual(await generateAssignmentDraft(extra, { client, instructions: "Use a formal tone" }), result);
  assert.deepEqual(await reviseAssignmentDraft(extra, "Old draft", "Improve thesis", { client }), result);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, "gemini-3.8-flash");
  assert.equal(calls[0].config.responseMimeType, "application/json");
  assert.equal(calls[0].config.maxOutputTokens, 4096);
  assert.match(calls[1].contents, /Old draft/);
  assert.match(calls[1].contents, /Improve thesis/);
  assert.doesNotMatch(JSON.stringify(calls), /secret-canvas-token|secret-rubric-token/);
});

test("rejects empty, malformed, and truncated Gemini output", async () => {
  for (const response of [{ text: "" }, { text: "{}" }, { text: JSON.stringify(result), candidates: [{ finishReason: "MAX_TOKENS" }] }]) {
    await assert.rejects(generateAssignmentDraft(context, { client: { models: { generateContent: async () => response } } }),
      (error) => error.code === "invalid_response");
  }
});

test("classifies rate limits, unavailable models, and network errors without leaking provider details", async () => {
  for (const [status, code] of [[429, "rate_limited"], [404, "model_unavailable"], [503, "api_failure"]]) {
    await assert.rejects(generateAssignmentDraft(context, {
      client: { models: { generateContent: async () => { throw Object.assign(new Error("secret-key"), { status }); } } },
    }), (error) => error.code === code && !error.message.includes("secret-key"));
  }
});

test("times out a stalled SDK call and rejects unsupported assignments", async () => {
  await assert.rejects(generateAssignmentDraft(context, {
    client: { models: { generateContent: () => new Promise(() => {}) } }, timeoutMs: 1000,
  }), (error) => error.code === "timeout");
  await assert.rejects(generateAssignmentDraft({ ...context, submissionTypes: ["external_tool"] }, {
    client: { models: { generateContent: () => { throw Error("must not call"); } } },
  }), (error) => error.code === "unsupported_assignment");
});

test("real Canvas client uses GET only and never sends a token to Gemini", async () => {
  const originalFetch = global.fetch;
  const originalBase = process.env.CANVAS_BASE_URL;
  const originalToken = process.env.CANVAS_ACCESS_TOKEN;
  const requests = [];
  process.env.CANVAS_BASE_URL = "https://canvas.example";
  process.env.CANVAS_ACCESS_TOKEN = "canvas-secret";
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ id: 34, name: "Essay" }) };
  };
  try {
    const value = await getAssignmentDraftContext(12, 34);
    assert.equal(value.title, "Essay");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.method, undefined);
    assert.equal(requests[0].url, "https://canvas.example/api/v1/courses/12/assignments/34");
  } finally {
    global.fetch = originalFetch;
    if (originalBase === undefined) delete process.env.CANVAS_BASE_URL;
    else process.env.CANVAS_BASE_URL = originalBase;
    if (originalToken === undefined) delete process.env.CANVAS_ACCESS_TOKEN;
    else process.env.CANVAS_ACCESS_TOKEN = originalToken;
  }
});

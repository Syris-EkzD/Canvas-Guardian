const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { createAssistant } = require("../src/guardian-ai");
const { generateAssignmentDraft, reviseAssignmentDraft } = require("../src/gemini-draft-engine");
const { resolveProvider, selectedModel } = require("../src/ai-provider");

const context = {
  courseId: "12", assignmentId: "34", title: "Essay",
  submissionTypes: ["online_text_entry"], description: "Reflection prompt",
  rubric: [], allowedExtensions: [],
};

test("a non-Gemini mock powers conversation, tool exchanges and assignment drafting", async () => {
  const db = new Database(":memory:");
  const calls = [];
  const createdDrafts = [];
  let round = 0;
  const provider = {
    async chat(input) {
      calls.push(["chat", input]);
      if (round++ === 0) return { toolCalls: [{
        name: "draft_assignment", args: { course_id: "12", assignment_id: "34" }, id: "mock-call",
      }] };
      assert.equal(input.messages.at(-1).role, "tool");
      assert.equal(input.messages.at(-1).toolResults[0].id, "mock-call");
      assert.equal(input.messages.at(-1).toolResults[0].result.sentFullDraftToUser, true);
      return { text: "Draft saved and sent." };
    },
    async draft(input) {
      calls.push(["draft", input]);
      return { text: JSON.stringify({ draft: "A mock draft", explanation: "A mock explanation", gaps: [] }) };
    },
  };
  const assistant = createAssistant({
    db, chatId: 42, provider, getContext: async () => context,
    listActivities: async () => [], getAnnouncements: async () => [], getStatus: () => ({}),
    onDraft: async item => createdDrafts.push(item),
  });
  assert.equal(await assistant.talk("Please draft assignment 12 34"), "Draft saved and sent.");
  assert.deepEqual(calls.map(item => item[0]), ["chat", "draft", "chat"]);
  assert.equal(createdDrafts[0].draft.draft, "A mock draft");
  const draft = await generateAssignmentDraft(context, { provider });
  assert.equal(draft.draft, "A mock draft");
  const revision = await reviseAssignmentDraft(context, draft.draft, "improve", { provider });
  assert.equal(revision.draft, "A mock draft");
  assert.ok(calls.filter(item => item[0] === "draft").every(item =>
    !JSON.stringify(item).includes("CANVAS_ACCESS_TOKEN")));
  db.close();
});

test("AI provider selection defaults to Gemini and rejects unknown providers without fallback", () => {
  const original = process.env.AI_PROVIDER;
  const model = process.env.AI_MODEL;
  try {
    process.env.AI_PROVIDER = "not-implemented";
    assert.throws(() => resolveProvider({}), /Unsupported AI_PROVIDER/);
    process.env.AI_PROVIDER = "gemini";
    assert.equal(resolveProvider({ apiKey: "" }), null);
    process.env.AI_MODEL = "";
    assert.equal(selectedModel("gemini-custom"), "gemini-custom");
    assert.ok(selectedModel().length > 0);
    assert.throws(() => resolveProvider({ provider: { chat: async () => {} } }), /chat and draft/);
  } finally {
    if (original === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = original;
    if (model === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = model;
  }
});

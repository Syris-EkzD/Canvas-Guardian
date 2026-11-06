const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { createAssistant, forgetConversation, loadHistory } = require("../src/guardian-ai");
const workspace = require("../src/ai-workspace");

const context = {
  courseId: "12", assignmentId: "34", title: "Essay",
  submissionTypes: ["online_text_entry"], description: "Write a reflection",
  rubric: [], allowedExtensions: [], dueAt: null, url: null,
};

function fixture() {
  const db = new Database(":memory:");
  const requests = [];
  const responses = [
    {
      functionCalls: [{ name: "list_activities", args: { view: "pending" } }],
      candidates: [{
        content: { role: "model", parts: [{ functionCall: {
          name: "list_activities", args: { view: "pending" },
        } }] }, finishReason: "STOP",
      }],
    },
    {
      text: "You have one pending essay.",
      candidates: [{ content: { role: "model", parts: [{ text: "You have one pending essay." }] }, finishReason: "STOP" }],
    },
  ];
  const client = { models: { generateContent: async request => {
    requests.push(request);
    return responses.shift();
  } } };
  const ai = createAssistant({
    db, chatId: 42, client,
    listActivities: async () => [{ courseId: "12", assignmentId: "34", title: "Essay" }],
    getAnnouncements: async () => [],
    getStatus: () => ({ monitoring: "running" }),
  });
  return { db, requests, ai };
}

test("Gemini tool calling uses authorized structured data and keeps bounded history", async () => {
  const { db, requests, ai } = fixture();
  assert.equal(await ai.talk("What is pending?"), "You have one pending essay.");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].config.tools[0].functionDeclarations.some(t => t.name === "prepare_text_submission"), true);
  assert.equal(requests[1].contents.at(-1).parts[0].functionResponse.name, "list_activities");
  assert.deepEqual(JSON.parse(JSON.stringify(requests[1].contents.at(-1).parts[0].functionResponse.response.result)).activities[0],
    { courseId: "12", assignmentId: "34", title: "Essay" });
  assert.deepEqual(loadHistory(db, 42).map(x => x.role), ["user", "model"]);
  forgetConversation(db, 42);
  assert.equal(loadHistory(db, 42).length, 0);
  db.close();
});

test("Gemini has no direct Canvas submit tool; prepared draft is reviewed separately", async () => {
  const { db, ai } = fixture();
  const events = [];
  const aware = createAssistant({
    db, chatId: 42,
    listActivities: async () => [], getAnnouncements: async () => [], getStatus: () => ({}),
    getContext: async () => context,
    generate: async () => ({
      draft: "My original reflection", explanation: "Matches instructions", gaps: ["Add sources"],
    }),
    stage: async (dbArg, chat, input) => {
      events.push({ chat, input });
      return { id: "abc", title: "Essay", submissionType: "online_text_entry" };
    },
    onDraft: async item => events.push({ draft: item.draft.draft }),
    onPreview: async item => events.push({ preview: item }),
  });
  const draft = await aware.execute("draft_assignment", { course_id: "12", assignment_id: "34" });
  assert.equal(draft.sentFullDraftToUser, true);
  const pending = await aware.execute("prepare_text_submission", { draft_id: draft.draftId });
  assert.equal(pending.status, "AWAITING_USER_REVIEW");
  assert.equal(events[1].input.payload, "My original reflection");
  assert.match(events[1].input.advice, /Revise before submitting/);
  assert.equal(events.length, 3);
  assert.equal(typeof ai.execute, "function");
  await assert.rejects(ai.execute("submit_canvas", {}), /unavailable/);
  db.close();
});

test("invalid or hallucinated function calls do not execute arbitrary operations", async () => {
  const { db, ai } = fixture();
  await assert.rejects(ai.execute("run_shell", { command: "rm -rf /" }), /unavailable/);
  await assert.rejects(ai.execute("list_activities", { view: "__proto__" }), /Invalid/);
  await assert.rejects(ai.execute("draft_assignment", { course_id: "/etc/passwd", assignment_id: "34" }), /positive Canvas ID|Invalid/);
  db.close();
});

test("conversation input has a strict size limit", async () => {
  const { db, ai } = fixture();
  await assert.rejects(ai.talk("A".repeat(3001)), /3000 characters/);
  db.close();
});

test("chat history and drafts are isolated by chat ID", () => {
  const db = new Database(":memory:");
  const id = workspace.saveDraft(db, 42, context, {
    draft: "private student work", explanation: "", gaps: [],
  });
  forgetConversation(db, 99);
  assert.ok(workspace.getDraft(db, 42, id));
  forgetConversation(db, 42);
  assert.equal(workspace.getDraft(db, 42, id), null);
  db.close();
});

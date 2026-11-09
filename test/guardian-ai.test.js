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
  const draft = await aware.execute("draft_assignment", { course_id: "12", assignment_id: "34" }, "Please draft assignment 12 34");
  assert.equal(draft.sentFullDraftToUser, true);
  const pending = await aware.execute("prepare_text_submission", { draft_id: draft.draftId }, "Prepare that draft for submission review");
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
  await assert.rejects(ai.execute("draft_assignment", { course_id: "/etc/passwd", assignment_id: "34" }, "draft assignment"), /positive Canvas ID|Invalid/);
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

test("AI setting tools stage proposals but cannot apply changes themselves", async () => {
  const db = new Database(":memory:");
  const changes = [];
  const proposals = [];
  const ai = createAssistant({
    db, chatId: 42,
    listActivities: async () => [], getAnnouncements: async () => [], getStatus: () => ({}),
    onSettingProposal: async proposal => proposals.push(proposal),
  });
  await assert.rejects(ai.execute("set_monitoring_mode", { mode: "paused" }), /Explicit/);
  await assert.rejects(ai.execute("set_monitoring_mode", { mode: "paused" }, "don't pause monitoring"), /Explicit/);
  await assert.rejects(ai.execute("set_monitoring_mode", { mode: "explode" }, "pause monitoring"), /Invalid/);
  await assert.rejects(ai.execute("set_calendar_mode", { mode: "sometimes" }, "disable calendar"), /Invalid/);
  assert.equal(proposals.length, 0);

  const pending = await ai.execute("set_monitoring_mode", { mode: "paused" }, "please pause monitoring");
  assert.equal(pending.status, "AWAITING_TELEGRAM_CONFIRMATION");
  assert.equal(proposals.length, 1);
  assert.equal(workspace.getSettingChange(db, 42, proposals[0].id).status, "pending");
  assert.deepEqual(changes, []);
  await workspace.confirmSettingChange(db, 42, proposals[0].id, {
    updateMonitoring: async mode => changes.push(["monitor", mode]),
  });
  assert.deepEqual(changes, [["monitor", "paused"]]);
  await assert.rejects(workspace.confirmSettingChange(db, 42, proposals[0].id, {
    updateMonitoring: async mode => changes.push(["monitor", mode]),
  }), /already used/);
  db.close();
});

test("provider tool output cannot draft, stage, or alter settings without explicit user request", async () => {
  const db = new Database(":memory:");
  const proposed = [];
  const outputs = [];
  let turns = 0;
  const provider = {
    chat: async ({ messages }) => {
      if (turns++ === 0) return { toolCalls: [
        { name: "set_monitoring_mode", args: { mode: "stopped" } },
        { name: "draft_assignment", args: { course_id: "12", assignment_id: "34" } },
        { name: "prepare_url_submission", args: { course_id: "12", assignment_id: "34", url: "https://example.org" } },
      ] };
      outputs.push(messages.at(-1));
      return { text: "No changes made." };
    },
    draft: async () => { throw new Error("draft should not run"); },
  };
  const ai = createAssistant({
    db, chatId: 42, provider,
    getContext: async () => { throw new Error("Canvas should not be fetched"); },
    listActivities: async () => [], getAnnouncements: async () => [], getStatus: () => ({}),
    onSettingProposal: async proposal => proposed.push(proposal),
  });
  assert.equal(await ai.talk("What's pending?"), "No changes made.");
  assert.deepEqual(proposed, []);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].toolResults.length, 3);
  assert.ok(outputs[0].toolResults.every(result => /Explicit/.test(result.result.error)));
  db.close();
});

test("AI state-changing tools require affirmative action wording, not keyword matches", async () => {
  const db = new Database(":memory:");
  const proposals = [];
  let draftCalls = 0;
  let revisionCalls = 0;
  let stageCalls = 0;
  const savedDraftId = workspace.saveDraft(db, 42, context, {
    draft: "Existing draft", explanation: "Existing explanation", gaps: [],
  });
  const ai = createAssistant({
    db, chatId: 42,
    listActivities: async () => [], getAnnouncements: async () => [], getStatus: () => ({}),
    getContext: async () => context,
    generate: async () => {
      draftCalls += 1;
      return { draft: "Generated draft", explanation: "Explanation", gaps: [] };
    },
    revise: async () => {
      revisionCalls += 1;
      return { draft: "Revised draft", explanation: "Explanation", gaps: [] };
    },
    stage: async () => {
      stageCalls += 1;
      return { id: "preview-1", title: "Essay", submissionType: "online_text_entry" };
    },
    onSettingProposal: async proposal => proposals.push(proposal),
  });

  const rejected = [
    ["set_monitoring_mode", { mode: "paused" }, "Should I pause monitoring?"],
    ["set_monitoring_mode", { mode: "paused" }, "What if I pause monitoring?"],
    ["set_monitoring_mode", { mode: "paused" }, "Maybe pause monitoring."],
    ["set_monitoring_mode", { mode: "paused" }, "Pause monitoring?"],
    ["set_monitoring_mode", { mode: "paused" }, "Don't pause monitoring."],
    ["set_monitoring_mode", { mode: "paused" }, "I don't want monitoring paused."],
    ["draft_assignment", { course_id: "12", assignment_id: "34" }, "I don't want to draft this."],
    ["draft_assignment", { course_id: "12", assignment_id: "34" }, "Would you draft this if I sent the rubric?"],
    ["draft_assignment", { course_id: "12", assignment_id: "34" }, "Tell me how to draft this assignment."],
    ["revise_draft", { draft_id: savedDraftId, feedback: "improve it" }, "Should I revise this draft?"],
    ["prepare_text_submission", { draft_id: savedDraftId }, "I don't want to submit this."],
    ["prepare_text_submission", { draft_id: savedDraftId }, "Can you explain what a submission is?"],
    ["prepare_text_submission", { draft_id: savedDraftId }, "Can you prepare for my exam?"],
    ["prepare_text_submission", { draft_id: savedDraftId }, "Submission?"],
    ["draft_assignment", { course_id: "12", assignment_id: "34" }, "Can you create a new assignment?"],
    ["prepare_url_submission", { course_id: "12", assignment_id: "34", url: "https://example.org" }, "Please prepare for the exam."],
    ["prepare_url_submission", { course_id: "12", assignment_id: "34", url: "https://example.org" }, "What if I submit this URL?"],
  ];
  for (const [name, args, message] of rejected) {
    await assert.rejects(ai.execute(name, args, message), /Explicit affirmative user action request/);
  }
  assert.equal(proposals.length, 0);
  assert.equal(draftCalls, 0);
  assert.equal(revisionCalls, 0);
  assert.equal(stageCalls, 0);

  const setting = await ai.execute("set_monitoring_mode", { mode: "paused" }, "Please pause monitoring");
  assert.equal(setting.status, "AWAITING_TELEGRAM_CONFIRMATION");
  assert.equal(proposals.length, 1);
  const politeSetting = await ai.execute("set_calendar_mode", { mode: "off" }, "Can you disable calendar sync?");
  assert.equal(politeSetting.status, "AWAITING_TELEGRAM_CONFIRMATION");
  assert.equal(proposals.length, 2);

  const generated = await ai.execute("draft_assignment", { course_id: "12", assignment_id: "34" },
    "Could you draft assignment 12 34?");
  assert.equal(generated.sentFullDraftToUser, true);
  assert.equal(draftCalls, 1);
  await ai.execute("revise_draft", { draft_id: savedDraftId, feedback: "improve the thesis" },
    "Please revise the draft");
  assert.equal(revisionCalls, 1);
  const prepared = await ai.execute("prepare_text_submission", { draft_id: savedDraftId },
    "Prepare the draft for submission review");
  assert.equal(prepared.status, "AWAITING_USER_REVIEW");
  assert.equal(stageCalls, 1);
  db.close();
});

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { MAX_DRAFT_LENGTH } = require("../src/ai-limits");
const {
  saveDraft, getDraft, stageSubmission, getRequest, reviewSubmission, cancelSubmission,
  confirmSubmission, postCanvasSubmission, stageSettingChange, getSettingChange,
  cancelSettingChange, confirmSettingChange, clearWorkspace, getWorkingContext, setActiveAssignment,
} = require("../src/ai-workspace");

function fixture() {
  const db = new Database(":memory:");
  const assignment = {
    id: 34, course_id: 12, name: "Essay", published: true,
    locked_for_user: false, submission_types: ["online_text_entry", "online_url"],
    submission: { workflow_state: "unsubmitted" },
  };
  const read = async () => assignment;
  return { db, assignment, read };
}

test("draft versions are saved separately and cannot be read by another chat", () => {
  const { db } = fixture();
  const context = { courseId: 12, assignmentId: 34 };
  const first = saveDraft(db, 42, context, { draft: "original", gaps: [] });
  const second = saveDraft(db, 42, context, { draft: "revised", gaps: ["Missing sources"] });
  assert.equal(getDraft(db, 42, first).body, "original");
  assert.equal(getDraft(db, 42, second).body, "revised");
  assert.equal(getDraft(db, 99, second), null);
  db.close();
});

test("explicit review consumes single-use approval and submits exact text", async () => {
  const { db, read } = fixture();
  const stage = () => stageSubmission(db, 42, {
    courseId: "12", assignmentId: "34", submissionType: "online_text_entry",
    payload: "Final exact answer <unescaped>", advice: "Verify quotations.",
  }, { read });
  const pending = await stage();
  assert.equal(getRequest(db, 42, pending.id).status, "staged");
  await assert.rejects(confirmSubmission(db, 42, pending.id, { read }), /not reviewed/);
  const reviewed = reviewSubmission(db, 42, pending.id);
  assert.equal(reviewed.payload, "Final exact answer <unescaped>");
  let count = 0;
  const result = await confirmSubmission(db, 42, pending.id, {
    read,
    submit: async item => {
      count += 1;
      assert.equal(item.payload, reviewed.payload);
      return { submittedAt: "2026-11-06T13:00:00Z", submissionType: item.submission_type };
    },
  });
  assert.equal(result.submissionType, "online_text_entry");
  assert.equal(count, 1);
  await assert.rejects(confirmSubmission(db, 42, pending.id, { read }), /already been used/);
  await assert.rejects(confirmSubmission(db, 99, pending.id, { read }), /not reviewed/);
  assert.equal(getRequest(db, 42, pending.id).status, "submitted");
  db.close();
});

test("new preview invalidates old approval and a cancelled preview cannot submit", async () => {
  const { db, read } = fixture();
  const input = { courseId: 12, assignmentId: 34, submissionType: "online_url", payload: "https://example.org/work" };
  const first = await stageSubmission(db, 42, input, { read });
  reviewSubmission(db, 42, first.id);
  const second = await stageSubmission(db, 42, input, { read });
  assert.equal(getRequest(db, 42, first.id).status, "cancelled");
  assert.equal(cancelSubmission(db, 42, second.id), true);
  assert.equal(cancelSubmission(db, 42, second.id), false);
  await assert.rejects(confirmSubmission(db, 42, second.id, { read }), /not reviewed/);
  db.close();
});

test("reject unsupported types, other assignment IDs, locked and submitted work", async () => {
  const { db, assignment, read } = fixture();
  const input = { courseId: 12, assignmentId: 34, submissionType: "online_text_entry", payload: "Draft" };
  await assert.rejects(stageSubmission(db, 42, { ...input, submissionType: "online_upload" }, { read }), /Only text/);
  assignment.submission_types = ["online_url"];
  await assert.rejects(stageSubmission(db, 42, input, { read }), /does not allow/);
  assignment.submission_types.push("online_text_entry");
  assignment.locked_for_user = true;
  await assert.rejects(stageSubmission(db, 42, input, { read }), /locked/);
  assignment.locked_for_user = false;
  assignment.submission.submitted_at = "2026-11-06T12:00:00Z";
  await assert.rejects(stageSubmission(db, 42, input, { read }), /existing submission/);
  assignment.submission.submitted_at = null;
  assignment.id = 99;
  await assert.rejects(stageSubmission(db, 42, input, { read }), /different assignment|invalid assignment/);
  db.close();
});

test("if Canvas changes after review, approval is cancelled without writing", async () => {
  const { db, assignment, read } = fixture();
  const pending = await stageSubmission(db, 42, {
    courseId: 12, assignmentId: 34, submissionType: "online_url",
    payload: "https://example.org/essay",
  }, { read });
  reviewSubmission(db, 42, pending.id);
  assignment.locked_for_user = true;
  let called = false;
  await assert.rejects(confirmSubmission(db, 42, pending.id, {
    read, submit: async () => { called = true; },
  }), /no submission was sent/);
  assert.equal(called, false);
  assert.equal(getRequest(db, 42, pending.id).status, "cancelled");
  db.close();
});

test("ambiguous submission failure is not automatically retried", async () => {
  const { db, read } = fixture();
  const pending = await stageSubmission(db, 42, {
    courseId: 12, assignmentId: 34, submissionType: "online_url",
    payload: "https://example.org/essay",
  }, { read });
  reviewSubmission(db, 42, pending.id);
  let count = 0;
  await assert.rejects(confirmSubmission(db, 42, pending.id, {
    read, submit: async () => { count++; throw new Error("network timed out"); },
  }), /uncertain/);
  await assert.rejects(confirmSubmission(db, 42, pending.id, { read }), /already been used/);
  assert.equal(count, 1);
  assert.equal(getRequest(db, 42, pending.id).status, "uncertain");
  db.close();
});

test("Canvas POST is confined to the assignment, escapes HTML and checks response", async () => {
  const calls = [];
  const submit = (item, response) => postCanvasSubmission(item, {
    baseUrl: "https://canvas.example.edu", token: "private",
    fetchImpl: async (url, args) => {
      calls.push({ url, args });
      return { ok: true, json: async () => response };
    },
  });
  const textItem = {
    course_id: "12", assignment_id: "34",
    submission_type: "online_text_entry", payload: "A < B & C\nD",
  };
  await submit(textItem, {
    assignment_id: 34, submission_type: "online_text_entry",
    submitted_at: "2026-11-06T13:00:00Z",
  });
  assert.match(calls[0].url, /courses\/12\/assignments\/34\/submissions$/);
  assert.equal(calls[0].args.method, "POST");
  assert.equal(calls[0].args.redirect, "error");
  assert.equal(calls[0].args.headers.Authorization, "Bearer private");
  assert.equal(new URLSearchParams(calls[0].args.body).get("submission[body]"), "A &lt; B &amp; C<br>D");
  await assert.rejects(submit(textItem, { submission_type: "online_text_entry" }), /could not be verified/);
});

test("unsafe URLs are rejected before any Canvas read", async () => {
  const { db, read } = fixture();
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "https://u:p@example.org/", "not a url"]) {
    await assert.rejects(stageSubmission(db, 42, {
      courseId: 12, assignmentId: 34, submissionType: "online_url", payload: url,
    }, { read }), /submission URL/i);
  }
  db.close();
});

test("setting confirmations are chat-bound, expire, and cannot be replayed", async () => {
  const db = new Database(":memory:");
  const changes = [];
  const opts = { updateMonitoring: async value => changes.push(["monitoring", value]),
    updateCalendar: async value => changes.push(["calendar", value]) };
  const created = stageSettingChange(db, 42, "monitoring", "paused", { now: 1000000 });
  assert.equal(getSettingChange(db, 42, created.id).status, "pending");
  await assert.rejects(confirmSettingChange(db, 99, created.id, { ...opts, now: 1000001 }), /unauthorized/);
  await assert.rejects(confirmSettingChange(db, 42, created.id, { ...opts, now: created.expiresAt }), /expired/);
  assert.deepEqual(changes, []);
  await confirmSettingChange(db, 42, created.id, { ...opts, now: 1000001 });
  await assert.rejects(confirmSettingChange(db, 42, created.id, { ...opts, now: 1000002 }), /already used/);
  assert.deepEqual(changes, [["monitoring", "paused"]]);

  const older = stageSettingChange(db, 42, "calendar", "off", { now: 2000000 });
  const newer = stageSettingChange(db, 42, "calendar", "on", { now: 2000001 });
  assert.equal(getSettingChange(db, 42, older.id).status, "cancelled");
  assert.equal(cancelSettingChange(db, 42, newer.id, { now: 2000002 }), true);
  assert.equal(cancelSettingChange(db, 42, newer.id, { now: 2000003 }), false);
  await assert.rejects(confirmSettingChange(db, 42, newer.id, { ...opts, now: 2000004 }), /already used/);
  assert.deepEqual(changes, [["monitoring", "paused"]]);
  db.close();
});

test("forget clears pending settings without changing any active configuration", () => {
  const db = new Database(":memory:");
  const proposed = stageSettingChange(db, 42, "monitoring", "stopped");
  clearWorkspace(db, 42);
  assert.equal(getSettingChange(db, 42, proposed.id).status, "cancelled");
  db.close();
});

test("the shared 12,000-character limit is enforced without truncation at persistence and staging", async () => {
  const { db, assignment, read } = fixture();
  assert.equal(MAX_DRAFT_LENGTH, 12000);
  const exact = "x".repeat(MAX_DRAFT_LENGTH);
  const tooLong = "x".repeat(MAX_DRAFT_LENGTH + 1);
  const context = { courseId: 12, assignmentId: 34 };

  const savedId = saveDraft(db, 42, context, { draft: exact, explanation: "", gaps: [] });
  assert.equal(getDraft(db, 42, savedId).body, exact);
  assert.throws(() => saveDraft(db, 42, context, { draft: tooLong, explanation: "", gaps: [] }),
    /12,000-character limit/);

  let reads = 0;
  const countedRead = async () => {
    reads += 1;
    return read();
  };
  const pending = await stageSubmission(db, 42, {
    courseId: 12, assignmentId: 34, submissionType: "online_text_entry", payload: exact,
  }, { read: countedRead });
  assert.equal(getRequest(db, 42, pending.id).payload, exact);
  const readsAtBoundary = reads;
  await assert.rejects(stageSubmission(db, 42, {
    courseId: 12, assignmentId: 34, submissionType: "online_text_entry", payload: tooLong,
  }, { read: countedRead }), /12,000-character draft limit/);
  assert.equal(reads, readsAtBoundary);
  assert.equal(assignment.id, 34);
  db.close();
});

test("saved versions keep only the latest active pointer per chat", () => {
  const db = new Database(":memory:");
  const original = saveDraft(db, 42, { courseId: 12, assignmentId: 34 }, { draft: "first" });
  const newest = saveDraft(db, 42, { courseId: 12, assignmentId: 34 }, { draft: "second" });
  const foreign = saveDraft(db, 99, { courseId: 78, assignmentId: 90 }, { draft: "foreign" });
  assert.equal(getWorkingContext(db, 42).draftId, newest);
  assert.equal(getWorkingContext(db, 99).draftId, foreign);
  assert.equal(getDraft(db, 42, original).body, "first");
  clearWorkspace(db, 42);
  assert.equal(getWorkingContext(db, 42), null);
  assert.equal(getWorkingContext(db, 99).draftId, foreign);
  db.close();
});

test("identically named Canvas assignments show distinct verified destinations and submit exact reviewed text", async () => {
  const db = new Database(":memory:");
  const contents = ["Full first-course answer < & >", "Full second-course answer"];
  const assign = (courseId, answer) => ({
    courseId, assignmentId: 34, submissionType: "online_text_entry", payload: answer,
    gaps: ["Missing references"], advice: "Review references before submission",
  });
  const read = async path => {
    const courseId = path.includes("/courses/12/") ? 12 : 56;
    return {
      id: 34, course_id: courseId, name: "Essay", course_name: courseId === 12 ? "History" : "Biology",
      html_url: "https://canvas.example.edu/courses/" + courseId + "/assignments/34",
      published: true, locked_for_user: false, submission_types: ["online_text_entry", "online_url"],
      submission: { workflow_state: "unsubmitted" },
    };
  };
  const p1 = await stageSubmission(db, 42, assign(12, contents[0]), { read });
  const p2 = await stageSubmission(db, 99, assign(56, contents[1]), { read });
  assert.equal(p1.title, "Essay");
  assert.equal(p2.title, "Essay");
  assert.equal(p1.courseId, "12");
  assert.equal(p2.courseId, "56");
  assert.notEqual(p1.assignmentUrl, p2.assignmentUrl);
  assert.equal(p1.assignmentUrl, "https://canvas.example.edu/courses/12/assignments/34");
  assert.equal(p1.courseName, "History");
  assert.deepEqual(p1.acceptedSubmissionTypes, ["online_text_entry", "online_url"]);
  assert.deepEqual(p1.gaps, ["Missing references"]);
  const review = reviewSubmission(db, 42, p1.id);
  assert.equal(review.payload, contents[0]);
  let submitted = 0;
  await confirmSubmission(db, 42, p1.id, {
    read,
    submit: async item => {
      submitted++;
      assert.equal(item.course_id, "12");
      assert.equal(item.assignment_id, "34");
      assert.equal(item.payload, contents[0]);
      return { submittedAt: "2026-11-10T08:00:00Z", submissionType: item.submission_type };
    },
  });
  assert.equal(submitted, 1);
  assert.equal(getRequest(db, 99, p2.id).status, "staged");
  db.close();
});

test("old SQLite submission rows gain destination metadata column without data loss", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE ai_submissions (" +
    "id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, course_id TEXT NOT NULL, " +
    "assignment_id TEXT NOT NULL, assignment_title TEXT NOT NULL, " +
    "submission_type TEXT NOT NULL, payload TEXT NOT NULL, advice TEXT NOT NULL, " +
    "status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)");
  db.prepare("INSERT INTO ai_submissions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "old-preview", "42", "12", "34", "Essay", "online_text_entry", "Unchanged", "Review", "staged",
    Date.now(), Date.now() + 900000);
  const original = getRequest(db, 42, "old-preview");
  assert.equal(original.payload, "Unchanged");
  assert.equal(original.destination_json, null);
  db.close();
});

test("same assignment retains the saved draft; different IDs clear it without crossing chats", () => {
  const db = new Database(":memory:");
  assert.equal(getWorkingContext(db, 42), null);
  setActiveAssignment(db, 42, { courseId: 12, assignmentId: 34 });
  assert.deepEqual(getWorkingContext(db, 42),
    { courseId: "12", assignmentId: "34", draftId: null });

  const first = saveDraft(db, 42, { courseId: 12, assignmentId: 34 }, { draft: "Version A" });
  assert.equal(getWorkingContext(db, 42).draftId, first);
  setActiveAssignment(db, 42, { courseId: "12", assignmentId: "34" });
  assert.equal(getWorkingContext(db, 42).draftId, first);

  const foreign = saveDraft(db, 99, { courseId: 12, assignmentId: 34 }, { draft: "Foreign" });
  setActiveAssignment(db, 42, { courseId: 12, assignmentId: 35 });
  assert.deepEqual(getWorkingContext(db, 42),
    { courseId: "12", assignmentId: "35", draftId: null });
  assert.equal(getWorkingContext(db, 99).draftId, foreign);

  setActiveAssignment(db, 42, { courseId: 12, assignmentId: 34 });
  assert.equal(getWorkingContext(db, 42).draftId, null);
  const newest = saveDraft(db, 42, { courseId: 12, assignmentId: 34 }, { draft: "Version B" });
  assert.equal(getWorkingContext(db, 42).draftId, newest);
  setActiveAssignment(db, 42, { courseId: 56, assignmentId: 34 });
  assert.deepEqual(getWorkingContext(db, 42),
    { courseId: "56", assignmentId: "34", draftId: null });
  assert.equal(getDraft(db, 42, first).body, "Version A");

  clearWorkspace(db, 42);
  assert.equal(getWorkingContext(db, 42), null);
  assert.equal(getWorkingContext(db, 99).draftId, foreign);
  db.close();
});

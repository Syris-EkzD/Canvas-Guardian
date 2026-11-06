const { randomUUID } = require("node:crypto");
const { canvasGet } = require("./canvas-client");

const LIFETIME_MS = 15 * 60 * 1000;
const MAX_TEXT = 12000;

function ensureTables(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS ai_drafts (" +
      "id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, course_id TEXT NOT NULL, " +
      "assignment_id TEXT NOT NULL, body TEXT NOT NULL, explanation TEXT NOT NULL, " +
      "gaps_json TEXT NOT NULL, created_at INTEGER NOT NULL);" +
    "CREATE TABLE IF NOT EXISTS ai_submissions (" +
      "id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, course_id TEXT NOT NULL, " +
      "assignment_id TEXT NOT NULL, assignment_title TEXT NOT NULL, " +
      "submission_type TEXT NOT NULL, payload TEXT NOT NULL, advice TEXT NOT NULL, " +
      "status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);"
  );
}

function validId(value) {
  const id = String(value);
  if (!/^[1-9][0-9]*$/.test(id)) throw new Error("Invalid Canvas assignment ID");
  return id;
}

function saveDraft(db, chatId, context, draft) {
  ensureTables(db);
  if (typeof draft.draft !== "string" || !draft.draft.trim() || draft.draft.length > MAX_TEXT) {
    throw new Error("Draft is empty or too long for the current Telegram workflow");
  }
  const id = randomUUID();
  db.prepare("INSERT INTO ai_drafts VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    id, String(chatId), validId(context.courseId), validId(context.assignmentId),
    draft.draft, draft.explanation || "", JSON.stringify(draft.gaps || []), Date.now()
  );
  db.prepare("DELETE FROM ai_drafts WHERE chat_id = ? AND id NOT IN (" +
    "SELECT id FROM ai_drafts WHERE chat_id = ? ORDER BY created_at DESC LIMIT 10)").run(
    String(chatId), String(chatId)
  );
  return id;
}

function getDraft(db, chatId, id) {
  ensureTables(db);
  return db.prepare("SELECT * FROM ai_drafts WHERE id = ? AND chat_id = ?").get(id, String(chatId)) || null;
}

function validateUrl(value) {
  if (typeof value !== "string" || value.length > 2000) throw new Error("Invalid submission URL");
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid submission URL"); }
  if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error("Submission URL must be a public HTTP(S) URL without credentials");
  }
  return url.href;
}

function validateAssignment(raw, courseId, assignmentId, submissionType) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Canvas returned an invalid assignment");
  }
  if (String(raw.id) !== assignmentId ||
      (raw.course_id != null && String(raw.course_id) !== courseId)) {
    throw new Error("Canvas returned a different assignment");
  }
  if (!raw.published || raw.locked_for_user || (raw.lock_at && Date.parse(raw.lock_at) <= Date.now())) {
    throw new Error("Assignment is unpublished or locked");
  }
  if (!Array.isArray(raw.submission_types) || !raw.submission_types.includes(submissionType)) {
    throw new Error("Canvas does not allow this submission type");
  }
  if (raw.group_category_id != null) throw new Error("Group submissions require manual Canvas review");
  const submission = raw.submission;
  if (submission?.submitted_at || ["submitted", "graded", "pending_review"].includes(submission?.workflow_state)) {
    throw new Error("An existing submission was detected; manual Canvas review is required");
  }
}

async function readAssignment(courseId, assignmentId, read = canvasGet) {
  return read(
    "/api/v1/courses/" + courseId + "/assignments/" + assignmentId + "?include[]=submission"
  );
}

async function stageSubmission(db, chatId, input, { read = canvasGet } = {}) {
  ensureTables(db);
  const courseId = validId(input.courseId);
  const assignmentId = validId(input.assignmentId);
  const type = input.submissionType;
  if (!["online_text_entry", "online_url"].includes(type)) {
    throw new Error("Only text-entry and URL submissions are supported");
  }
  let payload;
  if (type === "online_text_entry") {
    if (typeof input.payload !== "string" || !input.payload.trim() ||
        input.payload.length > MAX_TEXT) throw new Error("Submission text is invalid or too long");
    payload = input.payload;
  } else {
    payload = validateUrl(input.payload);
  }
  const raw = await readAssignment(courseId, assignmentId, read);
  validateAssignment(raw, courseId, assignmentId, type);
  const id = randomUUID();
  const now = Date.now();
  const advice = typeof input.advice === "string" ? input.advice.slice(0, 500) : "";
  // An older approval cannot be reused after a new version is prepared.
  db.prepare("UPDATE ai_submissions SET status = 'cancelled' WHERE chat_id = ? AND status IN ('staged', 'reviewed')").run(String(chatId));
  db.prepare("INSERT INTO ai_submissions VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, ?)").run(
    id, String(chatId), courseId, assignmentId, String(raw.name || "Untitled assignment"),
    type, payload, advice, now, now + LIFETIME_MS
  );
  return requestSummary(db, chatId, id);
}

function getRequest(db, chatId, id) {
  ensureTables(db);
  return db.prepare("SELECT * FROM ai_submissions WHERE id = ? AND chat_id = ?").get(id, String(chatId)) || null;
}

function requestSummary(db, chatId, id) {
  const item = getRequest(db, chatId, id);
  if (!item) throw new Error("Submission request not found");
  return {
    id: item.id,
    title: item.assignment_title,
    courseId: item.course_id,
    assignmentId: item.assignment_id,
    submissionType: item.submission_type,
    contentLength: item.payload.length,
    preview: item.payload.slice(0, 350),
    recommendation: item.advice || "Review the entire content and Canvas rubric before approving.",
    status: item.status,
    expiresAt: item.expires_at,
  };
}

function reviewSubmission(db, chatId, id) {
  const item = getRequest(db, chatId, id);
  if (!item || !["staged", "reviewed"].includes(item.status) || item.expires_at <= Date.now()) {
    throw new Error("Submission preview expired or unavailable. Prepare it again.");
  }
  db.prepare("UPDATE ai_submissions SET status = 'reviewed' WHERE id = ? AND chat_id = ? AND status = 'staged'").run(id, String(chatId));
  return { ...requestSummary(db, chatId, id), payload: item.payload };
}

function cancelSubmission(db, chatId, id) {
  ensureTables(db);
  return db.prepare("UPDATE ai_submissions SET status = 'cancelled' WHERE id = ? AND chat_id = ? AND status IN ('staged', 'reviewed')").run(id, String(chatId)).changes === 1;
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/\r\n|\r|\n/g, "<br>");
}

async function postCanvasSubmission(item, { fetchImpl = global.fetch, baseUrl = process.env.CANVAS_BASE_URL,
    token = process.env.CANVAS_ACCESS_TOKEN } = {}) {
  if (!baseUrl || !token) throw new Error("Canvas credentials are unavailable");
  const url = new URL("/api/v1/courses/" + item.course_id + "/assignments/" +
    item.assignment_id + "/submissions", baseUrl);
  if (url.origin !== new URL(baseUrl).origin) throw new Error("Canvas submission origin mismatch");
  const body = new URLSearchParams();
  body.set("submission[submission_type]", item.submission_type);
  body.set(item.submission_type === "online_text_entry" ? "submission[body]" : "submission[url]",
    item.submission_type === "online_text_entry" ? escapeHtml(item.payload) : item.payload);
  const response = await fetchImpl(url.href, {
    method: "POST", redirect: "error",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error("Canvas rejected the submission (HTTP " + response.status + ")");
  const result = await response.json();
  if (result?.submission_type !== item.submission_type || !result.submitted_at ||
      (result.assignment_id != null && String(result.assignment_id) !== item.assignment_id)) {
    throw new Error("Canvas submission response could not be verified");
  }
  return { submittedAt: result.submitted_at, submissionType: result.submission_type };
}

async function confirmSubmission(db, chatId, id, { read = canvasGet, submit = postCanvasSubmission } = {}) {
  const item = getRequest(db, chatId, id);
  if (!item || item.status !== "reviewed" || item.expires_at <= Date.now()) {
    throw new Error("Submission is not reviewed, has expired, or has already been used");
  }
  const claimed = db.prepare("UPDATE ai_submissions SET status = 'checking' WHERE id = ? AND chat_id = ? AND status = 'reviewed' AND expires_at > ?")
    .run(id, String(chatId), Date.now()).changes;
  if (!claimed) throw new Error("Submission approval was already consumed");
  try {
    const raw = await readAssignment(item.course_id, item.assignment_id, read);
    validateAssignment(raw, item.course_id, item.assignment_id, item.submission_type);
  } catch {
    db.prepare("UPDATE ai_submissions SET status = 'cancelled' WHERE id = ?").run(id);
    throw new Error("Canvas assignment could not be safely reverified; no submission was sent");
  }
  // The attempt is permanently consumed before POST. Ambiguous failures must not be auto-retried.
  db.prepare("UPDATE ai_submissions SET status = 'submitting' WHERE id = ?").run(id);
  try {
    const result = await submit(item);
    db.prepare("UPDATE ai_submissions SET status = 'submitted' WHERE id = ?").run(id);
    return result;
  } catch {
    db.prepare("UPDATE ai_submissions SET status = 'uncertain' WHERE id = ?").run(id);
    throw new Error("Submission outcome is uncertain. Check Canvas directly before attempting again.");
  }
}

function clearWorkspace(db, chatId) {
  ensureTables(db);
  db.prepare("DELETE FROM ai_drafts WHERE chat_id = ?").run(String(chatId));
  db.prepare("UPDATE ai_submissions SET status = 'cancelled' WHERE chat_id = ? AND status IN ('staged', 'reviewed')").run(String(chatId));
}

module.exports = {
  saveDraft, getDraft, stageSubmission, getRequest, requestSummary, reviewSubmission,
  cancelSubmission, confirmSubmission, clearWorkspace, validateUrl, validateAssignment,
  postCanvasSubmission,
};

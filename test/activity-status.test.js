const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const { filterPendingAssignments } = require("../src/activity-logic");
const {
  clearActivityStatusOverride,
  ensureActivityStatusTable,
  getActivityStatusOverride,
  getEffectiveActivityStatus,
  setActivityStatusOverride,
} = require("../src/activity-status");
const { selectReminderCandidates } = require("../src/deadline-monitor");

function assignment(courseId, id, changes = {}) {
  return {
    id: String(id),
    key: `${courseId}:${id}`,
    courseId: String(courseId),
    published: true,
    submitted: false,
    excused: false,
    dueAt: "2026-10-25T12:00:00.000Z",
    ...changes,
  };
}

test("manual status persists across database reopen and keys include the course", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-status-"));
  const filename = path.join(directory, "status.db");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let db = new Database(filename);
  ensureActivityStatusTable(db);
  ensureActivityStatusTable(db);
  const saved = setActivityStatusOverride(db, "10:25", "completed_offline");
  assert.match(saved.updatedAt, /^\d{4}-\d\d-\d\dT/);
  setActivityStatusOverride(db, "20:25", "dismissed");
  db.close();

  db = new Database(filename);
  assert.deepEqual(getActivityStatusOverride(db, "10:25"), saved);
  assert.equal(getActivityStatusOverride(db, "20:25").status, "dismissed");
  assert.equal(getActivityStatusOverride(db, "30:25"), null);
  assert.equal(getEffectiveActivityStatus(db, assignment(10, 25)), "completed_offline");
  assert.equal(getEffectiveActivityStatus(db, assignment(20, 25)), "dismissed");
  assert.equal(getEffectiveActivityStatus(db, assignment(30, 25)), "pending");

  db.prepare("UPDATE activity_status_overrides SET updated_at = ? WHERE assignment_key = ?")
    .run("2020-01-01T00:00:00.000Z", "20:25");
  const updated = setActivityStatusOverride(db, "20:25", "completed_offline");
  assert.equal(getActivityStatusOverride(db, "20:25").updatedAt, updated.updatedAt);
  assert.notEqual(updated.updatedAt, "2020-01-01T00:00:00.000Z");

  clearActivityStatusOverride(db, "10:25");
  assert.equal(getActivityStatusOverride(db, "10:25"), null);
  assert.equal(getEffectiveActivityStatus(db, assignment(10, 25)), "pending");
  assert.equal(getActivityStatusOverride(db, "20:25").status, "completed_offline");
  db.close();
});

test("only manual statuses can be stored", () => {
  const db = new Database(":memory:");

  for (const status of ["pending", "submitted", "excused", "other", null]) {
    assert.throws(
      () => setActivityStatusOverride(db, "1:1", status),
      /Invalid manual activity status/
    );
  }

  assert.equal(getActivityStatusOverride(db, "1:1"), null);
  db.close();
});

test("status table is initialized once per database connection", () => {
  let calls = 0;
  const db = { exec() { calls += 1; } };
  ensureActivityStatusTable(db);
  ensureActivityStatusTable(db);
  assert.equal(calls, 1);
});

test("Canvas submissions and excusals take precedence over manual status", () => {
  const db = new Database(":memory:");
  setActivityStatusOverride(db, "1:1", "dismissed");

  assert.equal(getEffectiveActivityStatus(db, assignment(1, 1, { submitted: true })), "submitted");
  assert.equal(getEffectiveActivityStatus(db, assignment(1, 1, { excused: true })), null);
  assert.equal(getEffectiveActivityStatus(db, assignment(1, 1, { published: false })), null);
  assert.equal(getActivityStatusOverride(db, "1:1").status, "dismissed");
  db.close();
});

test("pending and reminder filtering suppresses overrides while preserving legacy records", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE seen_activities (id TEXT PRIMARY KEY, seen_at TEXT NOT NULL);
    CREATE TABLE deadline_reminders (
      assignment_key TEXT NOT NULL,
      due_at TEXT NOT NULL,
      reminder_type TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      PRIMARY KEY (assignment_key, due_at, reminder_type)
    );
    INSERT INTO app_settings VALUES ('activity_baseline_created', '2026-10-01T00:00:00.000Z');
    INSERT INTO seen_activities VALUES ('17', '2026-10-01T00:00:00.000Z');
    INSERT INTO deadline_reminders VALUES ('1:17', '2026-10-25T12:00:00.000Z', '24_hours', '2026-10-24T12:00:00.000Z');
  `);

  const assignments = [
    assignment(1, 17),
    assignment(1, 18),
    assignment(1, 19),
    assignment(1, 20, { submitted: true }),
    assignment(1, 21, { excused: true }),
    assignment(1, 22, { dueAt: "2026-10-01T00:00:00.000Z" }),
  ];
  assert.deepEqual(filterPendingAssignments(assignments).map((item) => item.key), ["1:17", "1:18", "1:19", "1:22"]);

  setActivityStatusOverride(db, "1:18", "completed_offline");
  setActivityStatusOverride(db, "1:19", "dismissed");
  assert.deepEqual(filterPendingAssignments(assignments, db).map((item) => item.key), ["1:17", "1:22"]);
  assert.deepEqual(selectReminderCandidates(assignments, db).map((item) => item.key), ["1:22", "1:17"]);

  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key = 'activity_baseline_created'").get().value, "2026-10-01T00:00:00.000Z");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM seen_activities").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM deadline_reminders").get().count, 1);

  clearActivityStatusOverride(db, "1:18");
  assert.deepEqual(filterPendingAssignments(assignments, db).map((item) => item.key), ["1:17", "1:18", "1:22"]);
  db.close();
});

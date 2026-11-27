const { CoreError } = require("./core-errors");
const { openState, verifySchema, registryBinding, integrity, safeErrors } = require("./core-schema");
const { readOverrides, readStatus } = require("./core-read-state");

const unavailable = () => { throw new CoreError("SERVICE_UNAVAILABLE"); };
function createAcademicState({ binding, registryFile, expectedPath,
  maxCourses = 10_000, maxAssignments = 100_000 }) {
  const account = binding.accountId;
  let unverified = false;
  function transaction(work, write = false) {
    if (unverified) throw new CoreError("ACCOUNT_UNVERIFIED");
    let db;
    try {
      registryBinding(registryFile, binding);
      db = openState(binding, expectedPath, !write);
      const run = db.transaction(() => work(db, verifySchema(db, binding)));
      return write ? run.immediate() : run();
    } catch (error) {
      if (error instanceof CoreError) {
        if (error.code === "ACCOUNT_UNVERIFIED") unverified = true;
        throw error;
      }
      unavailable();
    } finally { db?.close(); }
  }
  function capture() {
    return transaction((db, sync) => sync.generation);
  }
  function recordFailure(generation, attemptedAt, code) {
    transaction((db, sync) => {
      // A late failed refresh must not replace a newer successful result.
      if (sync.generation !== generation) return;
      if (!safeErrors.includes(code)) code = "SERVICE_UNAVAILABLE";
      db.prepare("UPDATE guardian_sync SET last_attempt_at=?,last_result='failed',last_error_code=? WHERE account_id=?")
        .run(attemptedAt, code, account);
    }, true);
  }
  function publish(generation, candidate, attemptedAt, at) {
    return transaction((db, sync) => {
      if (sync.generation !== generation || !Number.isSafeInteger(generation + 1))
        throw new CoreError("SNAPSHOT_UNAVAILABLE");
      const next = generation + 1;
      // No external I/O inside this transaction. Mark absence only for
      // authoritative complete roster / assignment reads.
      db.prepare("UPDATE guardian_courses SET upstream_presence='not_in_active_roster' WHERE account_id=?").run(account);
      const upsertCourse = db.prepare("INSERT INTO guardian_courses VALUES (?,?,?,'active',NULL,0,?,?,'present',?,?) " +
        "ON CONFLICT(account_id,course_id) DO UPDATE SET course_name=excluded.course_name,last_seen_at=excluded.last_seen_at,upstream_presence='present',assignment_fetched_at=excluded.assignment_fetched_at,generation=excluded.generation");
      const absent = db.prepare("UPDATE guardian_assignments SET presence='not_in_latest_complete_course' WHERE account_id=? AND course_id=?");
      const upsertAssignment = db.prepare("INSERT INTO guardian_assignments VALUES (?,?,?,?,?,?,?,?,?,?,'present',?,?) " +
        "ON CONFLICT(account_id,course_id,assignment_id) DO UPDATE SET title=excluded.title,due_at=excluded.due_at,canvas_url=excluded.canvas_url,published=excluded.published,submitted=excluded.submitted,excused=excluded.excused,source_order=excluded.source_order,presence='present',last_seen_at=excluded.last_seen_at,generation=excluded.generation");
      for (const course of candidate.courses) {
        upsertCourse.run(account, course.id, course.course_code, at, at, at, next);
        absent.run(account, course.id);
      }
      for (const [order, item] of candidate.items.entries()) {
        upsertAssignment.run(account, item.courseId, item.id, item.name, item.dueAt ?? null,
          item.htmlUrl ?? null, Number(item.published), Number(item.submitted),
          item.excused == null ? null : Number(item.excused), order, at, next);
      }
      if (db.prepare("SELECT count(*) AS n FROM guardian_courses WHERE account_id=?").get(account).n > maxCourses ||
          db.prepare("SELECT count(*) AS n FROM guardian_assignments WHERE account_id=?").get(account).n > maxAssignments)
        throw new CoreError("SNAPSHOT_UNAVAILABLE");
      db.prepare("UPDATE guardian_sync SET generation=?,last_success_at=?,last_attempt_at=?,last_result='success',last_error_code=NULL WHERE account_id=?")
        .run(next, at, attemptedAt, account);
      return next;
    }, true);
  }
  function read({ courseId, activities = false, includeAssignments = false } = {}, project = value => value) {
    return transaction((db, sync) => {
      const courses = courseId === undefined
        ? db.prepare("SELECT * FROM guardian_courses WHERE account_id=? ORDER BY course_id LIMIT 10001").all(account)
        : db.prepare("SELECT * FROM guardian_courses WHERE account_id=? AND course_id=?").all(account, courseId);
      if (courses.length > maxCourses) unavailable();
      let assignments = [];
      if (activities) {
        assignments = db.prepare("SELECT a.*,c.course_name FROM guardian_assignments a JOIN guardian_courses c USING(account_id,course_id) " +
          "WHERE a.account_id=? AND c.upstream_presence='present' AND a.presence='present' ORDER BY a.source_order LIMIT 10001").all(account);
        if (assignments.length > 10_000) unavailable();
      } else if (courseId !== undefined && includeAssignments) {
        const count = db.prepare("SELECT count(*) AS n FROM guardian_assignments WHERE account_id=? AND course_id=?").get(account, courseId).n;
        if (count > maxAssignments) unavailable();
        assignments = db.prepare("SELECT * FROM guardian_assignments WHERE account_id=? AND course_id=? " +
          "ORDER BY due_at IS NULL,due_at,generation DESC,source_order,assignment_id").iterate(account, courseId);
      }
      return project({sync, courses, assignments,
        overrides: activities || includeAssignments ? readOverrides(db) : new Map()});
    });
  }
  transaction(db => integrity(db));
  return { capture, publish, recordFailure, read,
    status: () => transaction(db => readStatus(db)) };
}
module.exports = { createAcademicState };

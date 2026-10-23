const MANUAL_STATUSES = new Set(["completed_offline", "dismissed"]);
const initializedDatabases = new WeakSet();

function ensureActivityStatusTable(db) {
  if (initializedDatabases.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_status_overrides (
      assignment_key TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('completed_offline', 'dismissed')),
      updated_at TEXT NOT NULL
    );
  `);
  initializedDatabases.add(db);
}

function getActivityStatusOverride(db, assignmentKey) {
  ensureActivityStatusTable(db);

  return db.prepare(`
    SELECT status, updated_at AS updatedAt
    FROM activity_status_overrides
    WHERE assignment_key = ?
  `).get(assignmentKey) ?? null;
}

function setActivityStatusOverride(db, assignmentKey, status) {
  if (!MANUAL_STATUSES.has(status)) {
    throw new Error(`Invalid manual activity status: ${status}`);
  }

  ensureActivityStatusTable(db);
  const updatedAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO activity_status_overrides (assignment_key, status, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(assignment_key) DO UPDATE SET
      status = excluded.status,
      updated_at = excluded.updated_at
  `).run(assignmentKey, status, updatedAt);

  return { status, updatedAt };
}

function clearActivityStatusOverride(db, assignmentKey) {
  ensureActivityStatusTable(db);

  db.prepare(`
    DELETE FROM activity_status_overrides WHERE assignment_key = ?
  `).run(assignmentKey);
}

function getEffectiveActivityStatus(db, assignment) {
  if (assignment.submitted) {
    return "submitted";
  }

  if (!assignment.published || assignment.excused === true) {
    return null;
  }

  return (db && getActivityStatusOverride(db, assignment.key)?.status) || "pending";
}

module.exports = {
  clearActivityStatusOverride,
  ensureActivityStatusTable,
  getActivityStatusOverride,
  getEffectiveActivityStatus,
  setActivityStatusOverride,
};

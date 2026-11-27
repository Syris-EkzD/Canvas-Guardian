const Database = require("better-sqlite3");
const fs = require("node:fs");
const { CoreError } = require("./core-errors");

const unavailable = () => { throw new CoreError("SERVICE_UNAVAILABLE"); };

function checkTable(db, table, required) {
  const entry = db.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(table);
  if (!entry) return false;
  if (entry.type !== "table") unavailable();
  const columns = db.prepare("PRAGMA table_info(" + table + ")").all();
  for (const [name, pk, notnull] of required) {
    const col = columns.find(c => c.name === name);
    if (!col || col.type.toUpperCase() !== "TEXT" || col.pk !== pk || (notnull && !col.notnull)) unavailable();
  }
  return true;
}
function createReadState(statePath, busyTimeout = 250) {
  function read(work) {
    let db;
    try {
      if (!fs.statSync(statePath).isFile()) unavailable();
      db = new Database(statePath, { readonly: true, fileMustExist: true, timeout: busyTimeout });
      return db.transaction(() => work(db))();
    } catch { unavailable(); }
    finally { if (db) db.close(); }
  }
  return {
    overrides: () => read(readOverrides),
    status: () => read(readStatus),
  };
}
function readOverrides(db) {
  const result = new Map();
  if (!checkTable(db, "activity_status_overrides",
    [["assignment_key", 1, false], ["status", 0, true], ["updated_at", 0, true]])) return result;
  const rows = db.prepare("SELECT assignment_key, status, updated_at FROM activity_status_overrides LIMIT 10001").all();
  if (rows.length > 10000) unavailable();
  for (const row of rows) {
    if (typeof row.assignment_key !== "string" || !/^[1-9]\d{0,63}:[1-9]\d{0,63}$/.test(row.assignment_key) ||
        !["dismissed", "completed_offline"].includes(row.status) ||
        typeof row.updated_at !== "string" || !Number.isFinite(Date.parse(row.updated_at)) ||
        result.has(row.assignment_key)) unavailable();
    result.set(row.assignment_key, { status: row.status });
  }
  return result;
}
function readStatus(db) {
  const values = { monitoring: "running", calendarSyncEnabled: true };
  if (!checkTable(db, "app_settings", [["key", 1, false], ["value", 0, true]])) return values;
  const rows = db.prepare("SELECT key, value FROM app_settings WHERE key IN ('monitoring_state','calendar_sync_enabled')").all();
  for (const row of rows) {
    if (row.key === "monitoring_state") {
      if (!["running", "paused", "stopped"].includes(row.value)) unavailable();
      values.monitoring = row.value;
    } else {
      if (!["true", "false"].includes(row.value)) unavailable();
      values.calendarSyncEnabled = row.value === "true";
    }
  }
  return values;
}
module.exports = { createReadState, readOverrides, readStatus };

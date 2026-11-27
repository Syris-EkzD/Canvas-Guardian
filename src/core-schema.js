const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { CoreError } = require("./core-errors");
const { readRegistry, bindingOf } = require("./core-auth");
const { createCoreCanvas, configuredOrigin } = require("./core-canvas");

const LEGACY_PATH = path.resolve(__dirname, "../data/horus.db");
const unavailable = () => { throw new CoreError("SERVICE_UNAVAILABLE"); };
const mismatch = () => { throw new CoreError("ACCOUNT_UNVERIFIED"); };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ID = /^[1-9]\d{0,63}$/;
const safeErrors = ["UPSTREAM_FAILED", "UPSTREAM_INVALID", "UPSTREAM_TIMEOUT",
  "SERVICE_UNAVAILABLE", "ACCOUNT_UNVERIFIED", "SNAPSHOT_UNAVAILABLE"];
const legacy = {
  app_settings: "key TEXT PRIMARY KEY, value TEXT NOT NULL",
  activity_status_overrides: "assignment_key TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('completed_offline', 'dismissed')), updated_at TEXT NOT NULL",
  seen_activities: "id TEXT PRIMARY KEY, seen_at TEXT NOT NULL",
  seen_announcements: "id TEXT PRIMARY KEY, seen_at TEXT NOT NULL",
  deadline_reminders: "assignment_key TEXT NOT NULL, due_at TEXT NOT NULL, reminder_type TEXT NOT NULL, sent_at TEXT NOT NULL, PRIMARY KEY (assignment_key, due_at, reminder_type)",
  google_calendar_events: "assignment_key TEXT PRIMARY KEY, google_event_id TEXT NOT NULL, due_at TEXT NOT NULL, content_hash TEXT NOT NULL, synced_at TEXT NOT NULL",
  ai_chat_history: "id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL",
  ai_drafts: "id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, course_id TEXT NOT NULL, assignment_id TEXT NOT NULL, body TEXT NOT NULL, explanation TEXT NOT NULL, gaps_json TEXT NOT NULL, created_at INTEGER NOT NULL",
  ai_submissions: "id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, course_id TEXT NOT NULL, assignment_id TEXT NOT NULL, assignment_title TEXT NOT NULL, submission_type TEXT NOT NULL, payload TEXT NOT NULL, advice TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL",
  ai_setting_confirmations: "id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, setting TEXT NOT NULL, value TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL",
  ai_working_context: "chat_id TEXT PRIMARY KEY, course_id TEXT NOT NULL, assignment_id TEXT NOT NULL, draft_id TEXT",
};
const schema = {
  guardian_schema_migrations: "CREATE TABLE guardian_schema_migrations (version INTEGER PRIMARY KEY CHECK(version = 1), applied_at TEXT NOT NULL)",
  guardian_account: "CREATE TABLE guardian_account (slot INTEGER PRIMARY KEY CHECK(slot = 1), owner_id TEXT NOT NULL, account_id TEXT NOT NULL UNIQUE, canvas_origin TEXT NOT NULL, canvas_profile_id TEXT NOT NULL, state_path TEXT NOT NULL, attested_at TEXT NOT NULL, UNIQUE(canvas_origin, canvas_profile_id))",
  guardian_sync: "CREATE TABLE guardian_sync (account_id TEXT PRIMARY KEY NOT NULL REFERENCES guardian_account(account_id), generation INTEGER NOT NULL CHECK(generation >= 0), last_success_at TEXT, last_attempt_at TEXT, last_result TEXT NOT NULL CHECK(last_result IN ('never','success','failed')), last_error_code TEXT CHECK(last_error_code IN ('UPSTREAM_FAILED','UPSTREAM_INVALID','UPSTREAM_TIMEOUT','SERVICE_UNAVAILABLE','ACCOUNT_UNVERIFIED','SNAPSHOT_UNAVAILABLE')), CHECK((generation = 0 AND last_success_at IS NULL) OR (generation > 0 AND last_success_at IS NOT NULL)), CHECK((last_result = 'never' AND last_attempt_at IS NULL AND generation = 0 AND last_error_code IS NULL) OR (last_result = 'success' AND last_attempt_at IS NOT NULL AND generation > 0 AND last_error_code IS NULL) OR (last_result = 'failed' AND last_attempt_at IS NOT NULL AND last_error_code IS NOT NULL)))",
  guardian_courses: "CREATE TABLE guardian_courses (account_id TEXT NOT NULL REFERENCES guardian_account(account_id), course_id TEXT NOT NULL, course_name TEXT NOT NULL, local_state TEXT NOT NULL CHECK(local_state IN ('active','archived','restoring')), archived_at TEXT, state_version INTEGER NOT NULL CHECK(state_version >= 0), first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, upstream_presence TEXT NOT NULL CHECK(upstream_presence IN ('present','not_in_active_roster')), assignment_fetched_at TEXT, generation INTEGER NOT NULL CHECK(generation > 0), PRIMARY KEY(account_id, course_id))",
  guardian_assignments: "CREATE TABLE guardian_assignments (account_id TEXT NOT NULL, course_id TEXT NOT NULL, assignment_id TEXT NOT NULL, title TEXT NOT NULL, due_at TEXT, canvas_url TEXT, published INTEGER NOT NULL CHECK(published IN (0,1)), submitted INTEGER NOT NULL CHECK(submitted IN (0,1)), excused INTEGER CHECK(excused IN (0,1)), source_order INTEGER NOT NULL CHECK(source_order >= 0), presence TEXT NOT NULL CHECK(presence IN ('present','not_in_latest_complete_course')), last_seen_at TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation > 0), PRIMARY KEY(account_id,course_id,assignment_id), FOREIGN KEY(account_id,course_id) REFERENCES guardian_courses(account_id,course_id))",
  guardian_assignment_order: "CREATE INDEX guardian_assignment_order ON guardian_assignments(account_id,course_id,presence,source_order)",
};

// Compare known schema tokens, not row values or PRAGMA user_version. Quoted
// literals remain case-sensitive; legacy lazy destination_json ALTER is allowed.
function tokens(sql) {
  return (sql.match(/'(?:''|[^'])*'|[A-Za-z_][A-Za-z_0-9]*|\d+|[^\s;]/g) || [])
    .map(t => t.startsWith("'") ? t : t.toLowerCase()).join(" ");
}
function catalog(db) {
  return new Map(db.prepare("SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL").all()
    .map(row => [row.name, row]));
}
function validateLegacy(db) {
  const entries = catalog(db);
  for (const [name, columns] of Object.entries(legacy)) {
    const entry = entries.get(name);
    if (!entry) continue; // Legacy entrypoints initialize their own tables lazily.
    const allowed = [columns];
    if (name === "ai_submissions") allowed.push(columns + ", destination_json TEXT");
    if (entry.type !== "table" || !allowed.some(cols =>
      tokens(entry.sql) === tokens("CREATE TABLE " + name + " (" + cols + ")"))) unavailable();
  }
}
function validateBinding(binding, expectedPath) {
  if (!binding || binding.legacyOwnershipAttested !== true ||
      typeof binding.ownerId !== "string" || !UUID.test(binding.ownerId) ||
      typeof binding.accountId !== "string" || !UUID.test(binding.accountId) ||
      typeof binding.canvasProfileId !== "string" || !ID.test(binding.canvasProfileId) ||
      configuredOrigin(binding.canvasOrigin) !== binding.canvasOrigin ||
      binding.statePath !== expectedPath) mismatch();
}
function checkStatePath(file) {
  try {
    const dir = path.dirname(file);
    if (!path.isAbsolute(file) || path.normalize(file) !== file ||
        fs.realpathSync(file) !== file || fs.realpathSync(dir) !== dir ||
        (fs.statSync(dir).mode & 0o027) !== 0 ||
        !fs.lstatSync(file).isFile() || (fs.statSync(file).mode & 0o022) !== 0) unavailable();
  } catch { unavailable(); }
}
function openState(binding, expectedPath = LEGACY_PATH, readonly = false) {
  validateBinding(binding, expectedPath);
  checkStatePath(binding.statePath);
  let db;
  try {
    db = new Database(binding.statePath, {fileMustExist: true, readonly, timeout: 250});
    db.pragma("foreign_keys = ON");
    if (db.pragma("foreign_keys", {simple: true}) !== 1) unavailable();
    return db;
  } catch (error) {
    db?.close();
    if (error instanceof CoreError) throw error;
    unavailable();
  }
}
function integrity(db) {
  const result = db.pragma("integrity_check");
  if (result.length !== 1 || result[0].integrity_check !== "ok" ||
      db.pragma("foreign_key_check").length !== 0) unavailable();
}
function iso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}
function version(db) {
  const found = [...catalog(db)].filter(([name]) => name.toLowerCase().startsWith("guardian_"));
  if (!found.length) return 0;
  if (found.length !== Object.keys(schema).length) unavailable();
  for (const [name, entry] of found) {
    if (!Object.hasOwn(schema, name) || tokens(entry.sql) !== tokens(schema[name]) ||
        entry.type !== (name === "guardian_assignment_order" ? "index" : "table")) unavailable();
  }
  const rows = db.prepare("SELECT * FROM guardian_schema_migrations").all();
  if (rows.length !== 1 || rows[0].version !== 1 || !iso(rows[0].applied_at)) unavailable();
  return 1;
}
function verifySchema(db, binding) {
  if (version(db) !== 1) unavailable();
  const accounts = db.prepare("SELECT * FROM guardian_account").all();
  if (accounts.length !== 1) unavailable();
  const a = accounts[0];
  if (a.slot !== 1 || a.owner_id !== binding.ownerId || a.account_id !== binding.accountId ||
      a.canvas_origin !== binding.canvasOrigin || a.canvas_profile_id !== binding.canvasProfileId ||
      a.state_path !== binding.statePath) mismatch();
  if (!iso(a.attested_at)) unavailable();
  const sync = db.prepare("SELECT * FROM guardian_sync").all();
  if (sync.length !== 1 || sync[0].account_id !== binding.accountId ||
      !Number.isSafeInteger(sync[0].generation) || sync[0].generation < 0 ||
      [sync[0].last_success_at, sync[0].last_attempt_at].some(v => v !== null && !iso(v)) ||
      (sync[0].last_error_code !== null && !safeErrors.includes(sync[0].last_error_code))) unavailable();
  // CORE-2A deliberately cannot interpret or enforce archival state.
  if (db.prepare("SELECT 1 FROM guardian_courses WHERE account_id <> ? OR local_state <> 'active' OR archived_at IS NOT NULL LIMIT 1").get(binding.accountId) ||
      db.prepare("SELECT 1 FROM guardian_assignments WHERE account_id <> ? LIMIT 1").get(binding.accountId)) unavailable();
  return sync[0];
}
function registryBinding(file, binding) {
  if (!file || !path.isAbsolute(file) ||
      path.relative(path.resolve(__dirname, ".."), file).split(path.sep)[0] !== "..") unavailable();
  const actual = bindingOf(readRegistry(file));
  if (binding && JSON.stringify(actual) !== JSON.stringify(binding)) mismatch();
  return actual;
}
async function migrateCore({ registryFile, env = process.env, fetchImpl = global.fetch,
  expectedPath = LEGACY_PATH, backupPath, now = Date.now, beforeCommit = () => {} }) {
  const binding = registryBinding(registryFile);
  validateBinding(binding, expectedPath);
  if (configuredOrigin(env.CANVAS_BASE_URL) !== binding.canvasOrigin) mismatch();
  const db = openState(binding, expectedPath);
  try {
    validateLegacy(db);
    integrity(db);
    const originalVersion = version(db);
    if (originalVersion) verifySchema(db, binding);
    const canvas = createCoreCanvas({baseUrl: binding.canvasOrigin, token: env.CANVAS_ACCESS_TOKEN,
      profileId: binding.canvasProfileId, fetchImpl});
    await canvas.verify();
    registryBinding(registryFile, binding);
    if (originalVersion) {
      db.transaction(() => { validateLegacy(db); integrity(db); verifySchema(db, binding); }).immediate();
      return {version: 1, migrated: false};
    }

    // Caller must stop all writers. SQLite backup copies a consistent database,
    // including committed WAL pages. Never overwrite an existing backup.
    if (typeof backupPath !== "string" || !path.isAbsolute(backupPath) ||
        path.normalize(backupPath) !== backupPath || backupPath === binding.statePath ||
        fs.realpathSync(path.dirname(backupPath)) !== path.dirname(backupPath) ||
        (fs.statSync(path.dirname(backupPath)).mode & 0o027) !== 0) unavailable();
    const dataVersion = db.pragma("data_version", {simple: true});
    fs.closeSync(fs.openSync(backupPath, "wx", 0o600));
    await db.backup(backupPath);
    const backup = new Database(backupPath, {readonly: true, fileMustExist: true, timeout: 250});
    try { integrity(backup); validateLegacy(backup); if (version(backup) !== 0) unavailable(); }
    finally { backup.close(); }

    db.transaction(() => {
      registryBinding(registryFile, binding);
      checkStatePath(binding.statePath);
      if (version(db) !== 0 || db.pragma("data_version", {simple: true}) !== dataVersion) unavailable();
      validateLegacy(db);
      integrity(db);
      for (const sql of Object.values(schema)) db.exec(sql);
      const at = new Date(now()).toISOString();
      db.prepare("INSERT INTO guardian_account VALUES (1,?,?,?,?,?,?)")
        .run(binding.ownerId, binding.accountId, binding.canvasOrigin, binding.canvasProfileId, binding.statePath, at);
      db.prepare("INSERT INTO guardian_sync VALUES (?,0,NULL,NULL,'never',NULL)").run(binding.accountId);
      db.prepare("INSERT INTO guardian_schema_migrations VALUES (1,?)").run(at);
      beforeCommit(); // Synthetic rollback injection; CLI never supplies this.
      verifySchema(db, binding);
      integrity(db);
    }).immediate();
    return {version: 1, migrated: true};
  } catch (error) {
    if (error instanceof CoreError) throw error;
    unavailable();
  } finally { db.close(); }
}
if (require.main === module) {
  require("dotenv").config({quiet: true});
  const [backupPath, extra] = process.argv.slice(2);
  if (!backupPath || extra) {
    console.error("Usage: npm run guardian:core-migrate -- /absolute/protected/backup.db");
    process.exitCode = 1;
  } else {
    migrateCore({registryFile: process.env.GUARDIAN_CORE_REGISTRY, backupPath})
      .then(result => console.log(result.migrated ? "Guardian schema v1 migrated." : "Guardian schema v1 verified."))
      .catch(() => { console.error("Guardian migration failed; do not activate. Inspect offline."); process.exitCode = 1; });
  }
}
module.exports = { LEGACY_PATH, openState, verifySchema, registryBinding, integrity, migrateCore, safeErrors };

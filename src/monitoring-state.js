const VALID_STATES = new Set([
  "running",
  "paused",
  "stopped",
]);

function ensureMonitoringState(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  db.prepare(`
    INSERT OR IGNORE INTO app_settings (key, value)
    VALUES ('monitoring_state', 'running')
  `).run();
}

function getMonitoringState(db) {
  ensureMonitoringState(db);

  return db
    .prepare(`
      SELECT value
      FROM app_settings
      WHERE key = 'monitoring_state'
    `)
    .get().value;
}

function setMonitoringState(db, state) {
  if (!VALID_STATES.has(state)) {
    throw new Error(`Invalid monitoring state: ${state}`);
  }

  ensureMonitoringState(db);

  db.prepare(`
    INSERT INTO app_settings (key, value)
    VALUES ('monitoring_state', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(state);

  return state;
}

function getCalendarSyncEnabled(db) {
  ensureMonitoringState(db);

  db.prepare(`
    INSERT OR IGNORE INTO app_settings (key, value)
    VALUES ('calendar_sync_enabled', 'true')
  `).run();

  const value = db
    .prepare(`
      SELECT value
      FROM app_settings
      WHERE key = 'calendar_sync_enabled'
    `)
    .get()?.value;

  return value === "true";
}

function setCalendarSyncEnabled(db, enabled) {
  ensureMonitoringState(db);

  const value = enabled ? "true" : "false";

  db.prepare(`
    INSERT INTO app_settings (key, value)
    VALUES ('calendar_sync_enabled', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(value);

  return enabled;
}

module.exports = {
  getMonitoringState,
  setMonitoringState,
  getCalendarSyncEnabled,
  setCalendarSyncEnabled,
};
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { getReminderType } = require("../src/deadline-monitor");

test("deadline reminder thresholds are deterministic at their boundaries", () => {
  const now = Date.parse("2026-10-07T00:00:00.000Z");
  const dueAt = (milliseconds) => new Date(now + milliseconds).toISOString();
  const hour = 60 * 60 * 1000;

  assert.equal(getReminderType(dueAt(-1), now), null);
  assert.equal(getReminderType(dueAt(0), now), null);

  assert.deepEqual(getReminderType(dueAt(3 * hour), now), {
    type: "3_hours",
    label: "within 3 hours",
  });

  assert.deepEqual(getReminderType(dueAt(3 * hour + 1), now), {
    type: "24_hours",
    label: "within 24 hours",
  });

  assert.deepEqual(getReminderType(dueAt(24 * hour), now), {
    type: "24_hours",
    label: "within 24 hours",
  });

  assert.equal(getReminderType(dueAt(24 * hour + 1), now), null);
});

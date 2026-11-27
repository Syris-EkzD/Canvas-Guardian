const { test } = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { selectActivities } = require("../src/activity-query");
const { setActivityStatusOverride, getActivityStatusOverride } = require("../src/activity-status");
const { activityPage } = require("../src/telegram-bot");

const now = new Date("2026-11-27T11:00:00Z");
const assignment = (id, dueAt, extra = {}) => ({ id: String(id), key: "42:" + id, courseId: "42",
  course: "NET101", name: "Worksheet", dueAt, published: true, submitted: false, ...extra });
const items = [
  assignment(101, "2026-11-27T15:59:00Z"),
  assignment(102, "2026-11-27T00:00:00Z"),
  assignment(103, "2026-11-26T00:00:00Z"),
  assignment(104, null),
  assignment(105, "2026-12-04T11:00:00Z"),
  assignment(106, "2026-12-04T11:00:00.001Z"),
  assignment(107, "2026-11-27T12:00:00Z"),
  assignment(108, "2026-11-27T13:00:00Z"),
  assignment(109, "2026-11-27T13:00:00Z", { submitted: true }),
  assignment(110, "2026-11-27T13:00:00Z", { published: false }),
  assignment(111, "2026-11-27T13:00:00Z", { excused: true }),
];
const expected = { pending: [103,102,101,105,106,104], today: [102,101], week: [101,105], saved: [107,108] };
test("S02 exact fixture parity, including Telegram callback order and page union", () => {
  const db = new Database(":memory:");
  try {
    for (const [id, status] of [[107,"dismissed"],[108,"completed_offline"],[109,"dismissed"]])
      setActivityStatusOverride(db, "42:" + id, status);
    const read = key => getActivityStatusOverride(db, key);
    for (const [view, code] of Object.entries({pending:"p",today:"t",week:"w",saved:"a"})) {
      const keys = expected[view].map(id => "42:" + id);
      assert.deepEqual(selectActivities(items, read, view, now).map(x => x.item.key), keys);
      const pages = code === "t" ? 1 : Math.ceil(keys.length / 5);
      const callbacks = Array.from({length:pages}, (_, i) => activityPage(items, db, code, i, now))
        .flatMap(p => p.markup.inline_keyboard.flat().map(b => b.callback_data))
        .filter(s => s.startsWith("a1:s:")).map(s => s.slice(5));
      assert.deepEqual(callbacks, keys);
    }
  } finally { db.close(); }
});
test("Manila midnight, inclusive now, stable ties, and undated source ordering", () => {
  const a = [
    assignment(1,"2026-11-27T15:59:59.999Z"), assignment(2,"2026-11-27T16:00:00Z"),
    assignment(3,"2026-11-27T11:00:00Z"), assignment(4,"2026-11-27T11:00:00Z"),
    assignment(5,null), assignment(6,null),
  ];
  const ids = (view, at) => selectActivities(a, () => null, view, at).map(x => x.item.id);
  assert.deepEqual(ids("today", new Date("2026-11-27T15:59:59.999Z")), ["3","4","1"]);
  assert.deepEqual(ids("today", new Date("2026-11-27T16:00:00Z")), ["2"]);
  assert.deepEqual(ids("week", now), ["3","4","1","2"]);
  assert.deepEqual(ids("pending", now), ["3","4","1","2","5","6"]);
});
module.exports = { items, expected, now };

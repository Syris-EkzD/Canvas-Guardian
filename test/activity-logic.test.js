const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  filterActivitiesDueToday,
  filterActivitiesDueWithinWeek,
  filterPendingAssignments,
  isPendingAssignment,
} = require("../src/activity-logic");

test("pending assignments require published, unsubmitted, and not explicitly excused", () => {
  const cases = [
    [{ published: true, submitted: false, excused: false }, true],
    [{ published: true, submitted: false }, true],
    [{ published: true, submitted: false, excused: "yes" }, true],
    [{ published: true, submitted: false, excused: true }, false],
    [{ published: true, submitted: true, excused: false }, false],
    [{ published: false, submitted: false, excused: false }, false],
  ];

  for (const [assignment, expected] of cases) {
    assert.equal(isPendingAssignment(assignment), expected);
  }

  const assignments = cases.map(([assignment], index) => ({
    id: String(index),
    ...assignment,
  }));

  assert.deepEqual(
    filterPendingAssignments(assignments).map((assignment) => assignment.id),
    ["0", "1", "2"]
  );
});

test("today selection uses the Asia/Manila calendar day", () => {
  const now = new Date("2026-10-07T02:30:00.000Z");
  const activities = [
    { id: "today-start", dueAt: "2026-10-06T16:15:00.000Z" },
    { id: "today-end", dueAt: "2026-10-07T15:59:59.000Z" },
    { id: "tomorrow", dueAt: "2026-10-07T16:00:00.000Z" },
    { id: "no-date", dueAt: null },
  ];

  assert.deepEqual(
    filterActivitiesDueToday(activities, now).map((activity) => activity.id),
    ["today-start", "today-end"]
  );
});

test("week selection includes now through exactly seven days and excludes past dates", () => {
  const now = new Date("2026-10-07T02:30:00.000Z");
  const exactlySevenDays = new Date(
    now.getTime() + 7 * 24 * 60 * 60 * 1000
  );
  const outsideWindow = new Date(exactlySevenDays.getTime() + 1);

  const activities = [
    { id: "past", dueAt: "2026-10-07T02:29:59.999Z" },
    { id: "now", dueAt: now.toISOString() },
    { id: "within", dueAt: "2026-10-10T12:00:00.000Z" },
    { id: "boundary", dueAt: exactlySevenDays.toISOString() },
    { id: "outside", dueAt: outsideWindow.toISOString() },
    { id: "no-date", dueAt: null },
  ];

  assert.deepEqual(
    filterActivitiesDueWithinWeek(activities, now).map(
      (activity) => activity.id
    ),
    ["now", "within", "boundary"]
  );
});

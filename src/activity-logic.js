const { getEffectiveActivityStatus } = require("./activity-status");

function isPendingAssignment(assignment, db) {
  return getEffectiveActivityStatus(db, assignment) === "pending";
}

function filterPendingAssignments(assignments, db) {
  return assignments.filter((assignment) => isPendingAssignment(assignment, db));
}

function getManilaDateKey(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function filterActivitiesDueToday(activities, now) {
  const todayKey = getManilaDateKey(now);

  return activities.filter(
    (activity) =>
      activity.dueAt &&
      getManilaDateKey(new Date(activity.dueAt)) === todayKey
  );
}

function filterActivitiesDueWithinWeek(activities, now) {
  const sevenDaysFromNow = new Date(
    now.getTime() + 7 * 24 * 60 * 60 * 1000
  );

  return activities.filter((activity) => {
    if (!activity.dueAt) {
      return false;
    }

    const dueDate = new Date(activity.dueAt);

    return dueDate >= now && dueDate <= sevenDaysFromNow;
  });
}

module.exports = {
  filterActivitiesDueToday,
  filterActivitiesDueWithinWeek,
  filterPendingAssignments,
  getManilaDateKey,
  isPendingAssignment,
};

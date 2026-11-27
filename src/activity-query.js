const { resolveActivityStatus } = require("./activity-status");
const { filterActivitiesDueToday, filterActivitiesDueWithinWeek } = require("./activity-logic");

// Return original normalized objects for existing adapters, with the status
// evaluated once per item. Array.sort is stable for equal dates.
function selectActivities(assignments, readOverride, view, now = new Date()) {
  const selected = [];
  for (const item of assignments) {
    const status = resolveActivityStatus(item, readOverride);
    if (view === "saved" ? ["dismissed", "completed_offline"].includes(status) : status === "pending") {
      selected.push({ item, status, dueAt: item.dueAt });
    }
  }
  const filtered = view === "today" ? filterActivitiesDueToday(selected, now)
    : view === "week" ? filterActivitiesDueWithinWeek(selected, now) : selected;
  return filtered.sort((a, b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) -
    (b.dueAt ? Date.parse(b.dueAt) : Infinity));
}

module.exports = { selectActivities };

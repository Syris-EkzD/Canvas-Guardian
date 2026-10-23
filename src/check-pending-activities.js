require("dotenv").config({ quiet: true });

const path = require("path");
const Database = require("better-sqlite3");
const { getAllActiveCourseAssignments } = require("./canvas-assignments");
const { filterPendingAssignments } = require("./activity-logic");

function formatDate(dateString) {
  if (!dateString) {
    return "No due date";
  }

  return new Date(dateString).toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

async function main() {
  const db = new Database(path.join(__dirname, "..", "data", "horus.db"));
  const assignments = await getAllActiveCourseAssignments();
  const pendingActivities = filterPendingAssignments(assignments, db);

  pendingActivities.sort((a, b) => {
    if (!a.dueAt) return 1;
    if (!b.dueAt) return -1;
    return new Date(a.dueAt) - new Date(b.dueAt);
  });

  console.log(`Found ${pendingActivities.length} pending activity/activities.\n`);

  for (const activity of pendingActivities) {
    console.log(`[${activity.course}]`);
    console.log(activity.name);
    console.log(`Due: ${formatDate(activity.dueAt)}`);
    console.log(activity.htmlUrl);
    console.log("");
  }
}

main().catch((error) => {
  console.error("Pending activity check failed:", error.message);
  process.exit(1);
});

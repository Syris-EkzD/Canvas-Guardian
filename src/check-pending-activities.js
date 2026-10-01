require("dotenv").config({ quiet: true });

const { canvasGet } = require("./canvas-client");

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
  const courses = await canvasGet(
    "/api/v1/courses?enrollment_state=active&per_page=100"
  );

  const pendingActivities = [];

  for (const course of courses) {
    const assignments = await canvasGet(
      `/api/v1/courses/${course.id}/assignments?include[]=submission&order_by=due_at&per_page=100`
    );

    for (const assignment of assignments) {
      const submission = assignment.submission;

      const isSubmitted =
        Boolean(submission?.submitted_at) ||
        submission?.workflow_state === "submitted" ||
        submission?.workflow_state === "graded";

      const isExcused = submission?.excused === true;

      if (assignment.published && !isSubmitted && !isExcused) {
        pendingActivities.push({
          course: course.course_code || course.name,
          name: assignment.name,
          dueAt: assignment.due_at,
          htmlUrl: assignment.html_url,
        });
      }
    }
  }

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

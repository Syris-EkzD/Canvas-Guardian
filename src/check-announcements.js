require("dotenv").config({ quiet: true });

const { canvasGet } = require("./canvas-client");

async function main() {
  const courses = await canvasGet(
    "/api/v1/courses?enrollment_state=active&per_page=100"
  );

  const courseNames = new Map(
    courses.map((course) => [
      `course_${course.id}`,
      course.course_code || course.name,
    ])
  );

  const parameters = new URLSearchParams();
  parameters.set("per_page", "100");

  for (const course of courses) {
    parameters.append("context_codes[]", `course_${course.id}`);
  }

  const announcements = await canvasGet(
    `/api/v1/announcements?${parameters.toString()}`
  );

  announcements.sort(
    (a, b) => new Date(b.posted_at || 0) - new Date(a.posted_at || 0)
  );

  console.log(`Found ${announcements.length} announcement(s).\n`);

  for (const announcement of announcements.slice(0, 10)) {
    const course = courseNames.get(announcement.context_code) || "Unknown course";
    const date = announcement.posted_at
      ? new Date(announcement.posted_at).toLocaleString("en-PH", {
          timeZone: "Asia/Manila",
        })
      : "No date";

    console.log(`[${course}]`);
    console.log(announcement.title);
    console.log(`Posted: ${date}`);
    console.log(announcement.html_url);
    console.log("");
  }
}

main().catch((error) => {
  console.error("Announcement check failed:", error.message);
  process.exit(1);
});

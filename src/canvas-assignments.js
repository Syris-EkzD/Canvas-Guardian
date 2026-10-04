const { canvasGet, canvasGetAll } = require("./canvas-client");

const activeCoursesPath =
  "/api/v1/courses?enrollment_state=active&per_page=100";

function normalizeAssignment(course, assignment) {
  const submission = assignment.submission;

  return {
    id: String(assignment.id),
    key: `${course.id}:${assignment.id}`,
    courseId: String(course.id),
    course: course.course_code || course.name,
    name: assignment.name,
    dueAt: assignment.due_at,
    htmlUrl: assignment.html_url,
    published: assignment.published,
    submissionTypes: assignment.submission_types ?? [],
    externalToolUrl: assignment.external_tool_tag_attributes?.url ?? null,
    submitted:
      Boolean(submission?.submitted_at) ||
      submission?.workflow_state === "submitted" ||
      submission?.workflow_state === "graded",
    excused: submission?.excused,
    grade: submission?.grade ?? null,
    score: submission?.score ?? null,
    pointsPossible: assignment.points_possible ?? null,
    gradingType: assignment.grading_type ?? null,
  };
}

async function getActiveCourseAssignmentsWith(canvasRequest) {
  const courses = await canvasRequest(activeCoursesPath);
  const normalizedAssignments = [];

  for (const course of courses) {
    const assignments = await canvasRequest(
      `/api/v1/courses/${course.id}/assignments?include[]=submission&order_by=due_at&per_page=100`
    );

    for (const assignment of assignments) {
      normalizedAssignments.push(normalizeAssignment(course, assignment));
    }
  }

  return normalizedAssignments;
}

function getActiveCourseAssignments() {
  return getActiveCourseAssignmentsWith(canvasGet);
}

function getAllActiveCourseAssignments() {
  return getActiveCourseAssignmentsWith(canvasGetAll);
}

module.exports = {
  getActiveCourseAssignments,
  getAllActiveCourseAssignments,
};

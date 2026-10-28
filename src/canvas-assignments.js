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
      (submission?.workflow_state === "graded" &&
        submission?.missing !== true),
    excused: submission?.excused,
    grade: submission?.grade ?? null,
    score: submission?.score ?? null,
    pointsPossible: assignment.points_possible ?? null,
    gradingType: assignment.grading_type ?? null,
  };
}

async function getActiveCourseAssignmentsWith(canvasRequest, options) {
  const courses = await canvasRequest(activeCoursesPath, options);
  const normalizedAssignments = [];

  for (const course of courses) {
    const assignments = await canvasRequest(
      `/api/v1/courses/${course.id}/assignments?include[]=submission&order_by=due_at&per_page=100`,
      options
    );

    for (const assignment of assignments) {
      normalizedAssignments.push(normalizeAssignment(course, assignment));
    }
  }

  return normalizedAssignments;
}

function getActiveCourseAssignments(options) {
  return getActiveCourseAssignmentsWith(canvasGet, options);
}

function getAllActiveCourseAssignments(options) {
  return getActiveCourseAssignmentsWith(canvasGetAll, options);
}

// Verify one assignment directly before applying a local Guardian status change.
async function getAssignmentByKey(assignment, options) {
  const match = /^([1-9]\d*):([1-9]\d*)$/.exec(assignment?.key);
  if (!match) throw new Error("Invalid assignment key");

  const [, courseId, assignmentId] = match;
  const current = await canvasGet(
    `/api/v1/courses/${courseId}/assignments/${assignmentId}?include[]=submission`,
    options
  );
  if (String(current?.id) !== assignmentId ||
      (current.course_id !== undefined && String(current.course_id) !== courseId)) {
    throw new Error("Canvas returned a different assignment");
  }

  return normalizeAssignment({ id: courseId, course_code: assignment.course }, current);
}

module.exports = {
  getActiveCourseAssignments,
  getAllActiveCourseAssignments,
  getAssignmentByKey,
};

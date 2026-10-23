const { htmlToText } = require("html-to-text");
const { canvasGet } = require("./canvas-client");

function text(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned || null;
}

function description(value) {
  if (!text(value)) return null;
  return htmlToText(value, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
    ],
  }).trim() || null;
}

function validateId(value, name) {
  const id = String(value);
  if (!/^[1-9]\d*$/.test(id)) throw new TypeError(`${name} must be a positive Canvas ID`);
  return id;
}

function normalizeAssignmentContext(assignment, courseId, selectedAssignmentId) {
  if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)) {
    throw new Error("Canvas returned an invalid assignment");
  }
  if (String(assignment.id) !== selectedAssignmentId ||
      (assignment.course_id != null && String(assignment.course_id) !== courseId)) {
    throw new Error("Canvas returned a different assignment");
  }
  const rubric = Array.isArray(assignment.rubric)
    ? assignment.rubric.map((criterion) => ({
      description: text(criterion.description),
      details: description(criterion.long_description),
      points: Number.isFinite(criterion.points) ? criterion.points : null,
    }))
    : [];

  return {
    courseId,
    assignmentId: selectedAssignmentId,
    title: text(assignment.name),
    description: description(assignment.description),
    dueAt: text(assignment.due_at),
    submissionTypes: Array.isArray(assignment.submission_types)
      ? assignment.submission_types.filter((type) => typeof type === "string") : [],
    allowedExtensions: Array.isArray(assignment.allowed_extensions)
      ? assignment.allowed_extensions.filter((extension) => typeof extension === "string") : [],
    pointsPossible: Number.isFinite(assignment.points_possible) ? assignment.points_possible : null,
    rubric,
    url: text(assignment.html_url),
  };
}

/** Read only: fetch exactly the assignment selected by its Canvas course and assignment IDs. */
async function getAssignmentDraftContext(courseId, assignmentId, { canvasRequest = canvasGet, signal } = {}) {
  const course = validateId(courseId, "courseId");
  const selected = validateId(assignmentId, "assignmentId");
  const assignment = await canvasRequest(`/api/v1/courses/${course}/assignments/${selected}`, { signal });
  return normalizeAssignmentContext(assignment, course, selected);
}

module.exports = { getAssignmentDraftContext };

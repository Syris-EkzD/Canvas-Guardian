const { afterEach, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  getActiveCourseAssignments,
  getAllActiveCourseAssignments,
} = require("../src/canvas-assignments");

const baseUrl = "https://canvas.example.edu";
const accessToken = "test-access-token";
const coursesPath =
  "/api/v1/courses?enrollment_state=active&per_page=100";

let originalFetch;
let originalBaseUrl;
let originalAccessToken;

function restoreEnvironment(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function response(body, link = null) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    headers: {
      get: (name) => (name === "link" ? link : null),
    },
  };
}

beforeEach(() => {
  originalFetch = global.fetch;
  originalBaseUrl = process.env.CANVAS_BASE_URL;
  originalAccessToken = process.env.CANVAS_ACCESS_TOKEN;
  process.env.CANVAS_BASE_URL = baseUrl;
  process.env.CANVAS_ACCESS_TOKEN = accessToken;
});

afterEach(() => {
  global.fetch = originalFetch;
  restoreEnvironment("CANVAS_BASE_URL", originalBaseUrl);
  restoreEnvironment("CANVAS_ACCESS_TOKEN", originalAccessToken);
});

test("getActiveCourseAssignments requests exact paths and normalizes in source order", async () => {
  const requestedUrls = [];
  const firstAssignmentsPath =
    "/api/v1/courses/20/assignments?include[]=submission&order_by=due_at&per_page=100";
  const secondAssignmentsPath =
    "/api/v1/courses/10/assignments?include[]=submission&order_by=due_at&per_page=100";

  const responses = new Map([
    [
      `${baseUrl}${coursesPath}`,
      response([
        { id: 20, course_code: "CODE-20", name: "Course Twenty" },
        { id: 10, course_code: "", name: "Course Ten" },
      ]),
    ],
    [
      `${baseUrl}${firstAssignmentsPath}`,
      response([
        {
          id: 301,
          name: "Submitted with timestamp",
          due_at: "2026-10-10T08:00:00Z",
          points_possible: 25,
          grading_type: "points",
          html_url: "https://canvas.example.edu/assignments/301",
          published: true,
          submission_types: ["external_tool"],
          external_tool_tag_attributes: {
            url: "https://rollcall-sin.instructure.com/launch",
          },
          submission: {
            submitted_at: "2026-10-01T08:00:00Z",
            workflow_state: "unsubmitted",
            excused: "raw-excused-value",
            grade: "A",
            score: 23.5,
          },
        },
        {
          id: 302,
          name: "Submitted workflow",
          due_at: null,
          html_url: "https://canvas.example.edu/assignments/302",
          published: false,
          submission: { workflow_state: "submitted", excused: false },
        },
      ]),
    ],
    [
      `${baseUrl}${secondAssignmentsPath}`,
      response([
        {
          id: 101,
          name: "Graded workflow",
          due_at: "2026-10-11T08:00:00Z",
          html_url: "https://canvas.example.edu/assignments/101",
          published: true,
          submission: { workflow_state: "graded", excused: true },
        },
        {
          id: 102,
          name: "Unsubmitted",
          due_at: "2026-10-12T08:00:00Z",
          html_url: "https://canvas.example.edu/assignments/102",
          published: true,
        },
      ]),
    ],
  ]);

  global.fetch = async (url) => {
    requestedUrls.push(url);
    assert.ok(responses.has(url), `Unexpected URL: ${url}`);
    return responses.get(url);
  };

  const assignments = await getActiveCourseAssignments();

  assert.deepEqual(requestedUrls, [
    `${baseUrl}${coursesPath}`,
    `${baseUrl}${firstAssignmentsPath}`,
    `${baseUrl}${secondAssignmentsPath}`,
  ]);
  assert.deepEqual(
    assignments.map((assignment) => assignment.name),
    [
      "Submitted with timestamp",
      "Submitted workflow",
      "Graded workflow",
      "Unsubmitted",
    ]
  );
  assert.deepEqual(assignments[0], {
    id: "301",
    key: "20:301",
    courseId: "20",
    course: "CODE-20",
    name: "Submitted with timestamp",
    dueAt: "2026-10-10T08:00:00Z",
    htmlUrl: "https://canvas.example.edu/assignments/301",
    published: true,
    submissionTypes: ["external_tool"],
    externalToolUrl: "https://rollcall-sin.instructure.com/launch",
    submitted: true,
    excused: "raw-excused-value",
    grade: "A",
    score: 23.5,
    pointsPossible: 25,
    gradingType: "points",
  });
  assert.equal(assignments[1].submitted, true);
  assert.equal(assignments[2].submitted, true);
  assert.equal(assignments[2].course, "Course Ten");
  assert.equal(assignments[3].submitted, false);
  assert.equal(assignments[3].excused, undefined);
  assert.equal(assignments[1].grade, null);
  assert.equal(assignments[3].grade, null);
  assert.equal(assignments[1].score, null);
  assert.equal(assignments[1].pointsPossible, null);
  assert.equal(assignments[1].gradingType, null);
  assert.deepEqual(assignments[1].submissionTypes, []);
  assert.equal(assignments[1].externalToolUrl, null);
  assert.equal(assignments[3].score, null);
  assert.equal(assignments[3].pointsPossible, null);
  assert.equal(assignments[3].gradingType, null);
  assert.deepEqual(assignments[3].submissionTypes, []);
  assert.equal(assignments[3].externalToolUrl, null);
});

test("getAllActiveCourseAssignments includes later course and assignment pages in order", async () => {
  const requestedUrls = [];
  const coursesPageTwo = `${baseUrl}/api/v1/courses?page=2`;
  const courseOneAssignments = `${baseUrl}/api/v1/courses/1/assignments?include[]=submission&order_by=due_at&per_page=100`;
  const courseOneAssignmentsPageTwo = `${baseUrl}/api/v1/courses/1/assignments?page=2`;
  const courseTwoAssignments = `${baseUrl}/api/v1/courses/2/assignments?include[]=submission&order_by=due_at&per_page=100`;

  const responses = new Map([
    [
      `${baseUrl}${coursesPath}`,
      response(
        [{ id: 1, course_code: "ONE", name: "One" }],
        `<${coursesPageTwo}>; rel="next", <${coursesPageTwo}>; rel="last"`
      ),
    ],
    [
      coursesPageTwo,
      response([{ id: 2, course_code: "TWO", name: "Two" }]),
    ],
    [
      courseOneAssignments,
      response(
        [{ id: 11, name: "One-A", published: true }],
        `<${courseOneAssignmentsPageTwo}>; rel="next", <${courseOneAssignmentsPageTwo}>; rel="last"`
      ),
    ],
    [
      courseOneAssignmentsPageTwo,
      response([{ id: 12, name: "One-B", published: true }]),
    ],
    [
      courseTwoAssignments,
      response([{ id: 21, name: "Two-A", published: true }]),
    ],
  ]);

  global.fetch = async (url) => {
    requestedUrls.push(url);
    assert.ok(responses.has(url), `Unexpected URL: ${url}`);
    return responses.get(url);
  };

  const assignments = await getAllActiveCourseAssignments();

  assert.deepEqual(requestedUrls, [
    `${baseUrl}${coursesPath}`,
    coursesPageTwo,
    courseOneAssignments,
    courseOneAssignmentsPageTwo,
    courseTwoAssignments,
  ]);
  assert.deepEqual(
    assignments.map((assignment) => assignment.key),
    ["1:11", "1:12", "2:21"]
  );
  assert.deepEqual(
    assignments.map((assignment) => assignment.course),
    ["ONE", "ONE", "TWO"]
  );
  assert.deepEqual(
    assignments.map((assignment) => assignment.courseId),
    ["1", "1", "2"]
  );
});

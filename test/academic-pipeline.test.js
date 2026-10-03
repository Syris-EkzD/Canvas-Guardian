const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parse } = require("csv-parse/sync");

const {
  aggregateAttendanceByCourse,
  formatAcademicCsv,
  mergeAcademicData,
  outputColumns,
  requireMergedRows,
} = require("../src/academic-pipeline");

test("aggregates attendance and joins assignments by course ID", () => {
  const attendance = [
    { courseId: "9001", classDate: "2042-03-18", status: "late" },
    { courseId: "9001", classDate: "2042-03-04", status: "present" },
    { courseId: "9001", classDate: "2042-03-11", status: "absent" },
    { courseId: "9001", classDate: "2042-03-25", status: "present" },
    { courseId: "9002", classDate: "2042-03-07", status: "present" },
  ];
  const assignments = [
    {
      id: "501",
      key: "9001:501",
      courseId: "9001",
      course: "ART 123-X",
      name: "Color study",
      dueAt: "2042-04-01T08:00:00Z",
      htmlUrl: "https://canvas.invalid/courses/9001/assignments/501",
      published: true,
      submitted: false,
      excused: undefined,
    },
    {
      id: "502",
      courseId: "9999",
      course: "OTHER 456-Y",
      name: "Unrelated assignment",
      dueAt: null,
      published: true,
      submitted: true,
      excused: false,
    },
  ];

  const rows = mergeAcademicData(
    assignments,
    aggregateAttendanceByCourse(attendance)
  );

  assert.deepEqual(rows, [
    {
      course_id: "9001",
      course: "ART 123-X",
      assignment_id: "501",
      assignment_name: "Color study",
      due_at: "2042-04-01T08:00:00Z",
      published: true,
      submitted: false,
      excused: undefined,
      attendance_records: 4,
      present_count: 2,
      absent_count: 1,
      late_count: 1,
      attendance_first_date: "2042-03-04",
      attendance_last_date: "2042-03-25",
    },
  ]);
});

test("formats a human-readable report with display statuses and dates", () => {
  const sharedFields = {
    course_id: "9001",
    course: "ART 123-X",
    published: true,
    attendance_records: 4,
    present_count: 2,
    absent_count: 1,
    late_count: 1,
    attendance_first_date: "2042-03-04",
    attendance_last_date: "2042-03-25",
  };
  const csv = formatAcademicCsv([
    {
      ...sharedFields,
      assignment_id: "501",
      assignment_name: 'Study, "light"',
      due_at: "2026-07-14T01:00:00Z",
      submitted: true,
      excused: undefined,
    },
    {
      ...sharedFields,
      assignment_id: "502",
      assignment_name: "Pending project",
      due_at: null,
      submitted: false,
      excused: false,
    },
    {
      ...sharedFields,
      assignment_id: "503",
      assignment_name: "Roll Call Attendance",
      due_at: "2026-07-14T01:00:00Z",
      submitted: true,
      excused: true,
    },
    {
      ...sharedFields,
      assignment_id: "504",
      assignment_name: "Roll Call Attendance",
      due_at: null,
      submitted: true,
      excused: false,
    },
  ]);
  const records = parse(csv, { columns: true });

  assert.deepEqual(Object.keys(records[0]), outputColumns);
  assert.equal(records[0].Assignment, 'Study, "light"');
  assert.equal(records[0]["Due Date"], "Jul 14, 2026, 9:00 AM");
  assert.equal(records[0].Status, "Submitted");
  assert.equal(records[0]["Attendance From"], "Mar 4, 2042");
  assert.equal(records[0]["Attendance Through"], "Mar 25, 2042");
  assert.equal(records[1]["Due Date"], "");
  assert.equal(records[1].Status, "Pending");
  assert.equal(records[2].Status, "Excused");
  assert.equal(records[3].Status, "Attendance Record");
  assert.match(csv, /"Study, ""light"""/);
  assert.match(csv, /"Jul 14, 2026, 9:00 AM"/);
  assert.ok(csv.endsWith("\n"));
});

test("requires at least one assignment matched to attendance courses", () => {
  assert.throws(
    () => requireMergedRows([]),
    /No Canvas assignments matched the attendance course IDs/
  );
});

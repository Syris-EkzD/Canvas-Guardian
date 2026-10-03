const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  aggregateAttendanceByCourse,
  formatAcademicCsv,
  mergeAcademicData,
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

test("formats merged rows as escaped CSV", () => {
  const csv = formatAcademicCsv([
    {
      course_id: "9001",
      course: "ART 123-X",
      assignment_id: "501",
      assignment_name: 'Study, "light"',
      due_at: null,
      published: true,
      submitted: false,
      excused: undefined,
      attendance_records: 1,
      present_count: 1,
      absent_count: 0,
      late_count: 0,
      attendance_first_date: "2042-03-04",
      attendance_last_date: "2042-03-04",
    },
  ]);

  assert.match(csv, /"Study, ""light"""/);
  assert.ok(csv.endsWith("\n"));
});

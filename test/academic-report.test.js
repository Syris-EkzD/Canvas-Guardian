const { test } = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");

const {
  buildAssignmentRows,
  buildAttendanceRows,
  buildSummaryRows,
  createAcademicWorkbook,
  sheetDefinitions,
} = require("../src/academic-report");

const assignments = [
  {
    id: "501",
    courseId: "9001",
    course: "ART 123-X",
    name: "Submitted study",
    dueAt: "2026-07-14T01:00:00Z",
    submitted: true,
    excused: false,
    grade: "95",
  },
  {
    id: "502",
    courseId: "9001",
    course: "ART 123-X",
    name: "Pending project",
    dueAt: null,
    submitted: false,
    excused: false,
    grade: null,
  },
  {
    id: "503",
    courseId: "9001",
    course: "ART 123-X",
    name: "Roll Call Attendance",
    dueAt: null,
    submitted: false,
    excused: true,
    grade: null,
  },
  {
    id: "504",
    courseId: "9001",
    course: "ART 123-X",
    name: "roll call attendance",
    dueAt: null,
    submitted: true,
    excused: false,
    grade: "78%",
  },
  {
    id: "601",
    courseId: "9002",
    course: "SCI 456-Y",
    name: "Lab notes",
    dueAt: "2026-07-20T16:00:00Z",
    submitted: false,
    excused: false,
    grade: "",
  },
];

const attendance = [
  {
    courseId: "9001",
    courseCode: "ART 123-X",
    classDate: "2042-03-18",
    status: "late",
  },
  {
    courseId: "9001",
    courseCode: "ART 123-X",
    classDate: "2042-03-04",
    status: "present",
  },
  {
    courseId: "9001",
    courseCode: "ART 123-X",
    classDate: "2042-03-11",
    status: "absent",
  },
];

test("builds assignment rows with display statuses, grades, and Manila dates", () => {
  assert.deepEqual(buildAssignmentRows(assignments), [
    {
      course: "ART 123-X",
      assignment: "Submitted study",
      dueDate: "Jul 14, 2026, 9:00 AM",
      status: "Submitted",
      grade: "95",
    },
    {
      course: "ART 123-X",
      assignment: "Pending project",
      dueDate: null,
      status: "Pending",
      grade: null,
    },
    {
      course: "ART 123-X",
      assignment: "Roll Call Attendance",
      dueDate: null,
      status: "Excused",
      grade: null,
    },
    {
      course: "ART 123-X",
      assignment: "roll call attendance",
      dueDate: null,
      status: "Attendance Record",
      grade: "78%",
    },
    {
      course: "SCI 456-Y",
      assignment: "Lab notes",
      dueDate: "Jul 21, 2026, 12:00 AM",
      status: "Pending",
      grade: "",
    },
  ]);
});

test("builds attendance rows with readable dates and statuses", () => {
  assert.deepEqual(buildAttendanceRows(attendance), [
    { course: "ART 123-X", classDate: "Mar 18, 2042", status: "Late" },
    { course: "ART 123-X", classDate: "Mar 4, 2042", status: "Present" },
    { course: "ART 123-X", classDate: "Mar 11, 2042", status: "Absent" },
  ]);
});

test("summarizes assignments and attendance once per Canvas course", () => {
  assert.deepEqual(buildSummaryRows(assignments, attendance), [
    {
      course: "ART 123-X",
      totalAssignments: 4,
      submitted: 2,
      pending: 1,
      excused: 1,
      graded: 2,
      attendanceRecords: 3,
      present: 1,
      absent: 1,
      late: 1,
      attendanceFrom: "Mar 4, 2042",
      attendanceThrough: "Mar 18, 2042",
    },
    {
      course: "SCI 456-Y",
      totalAssignments: 1,
      submitted: 0,
      pending: 1,
      excused: 0,
      graded: 0,
      attendanceRecords: null,
      present: null,
      absent: null,
      late: null,
      attendanceFrom: null,
      attendanceThrough: null,
    },
  ]);
});

test("creates the three formatted report sheets in the required order", async () => {
  const workbook = createAcademicWorkbook(assignments, attendance);
  const buffer = await workbook.xlsx.writeBuffer();
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(buffer);

  assert.deepEqual(
    reloaded.worksheets.map((sheet) => sheet.name),
    ["Summary", "Assignments", "Attendance"]
  );

  for (const worksheet of reloaded.worksheets) {
    const expectedHeaders = sheetDefinitions[worksheet.name].map(
      (column) => column.header
    );
    assert.deepEqual(
      worksheet.getRow(1).values.slice(1),
      expectedHeaders
    );
    assert.equal(worksheet.getRow(1).font.bold, true);
    assert.equal(worksheet.views[0].state, "frozen");
    assert.equal(worksheet.views[0].ySplit, 1);
    assert.ok(worksheet.autoFilter);
  }

  const assignmentSheet = reloaded.getWorksheet("Assignments");
  assert.deepEqual(assignmentSheet.getRow(2).values.slice(1), [
    "ART 123-X",
    "Submitted study",
    "Jul 14, 2026, 9:00 AM",
    "Submitted",
    "95",
  ]);
  assert.equal(assignmentSheet.getCell("E3").value, null);

  const summarySheet = reloaded.getWorksheet("Summary");
  assert.equal(summarySheet.getCell("G3").value, null);
  assert.equal(summarySheet.getCell("K3").value, null);

  const attendanceSheet = reloaded.getWorksheet("Attendance");
  assert.equal(attendanceSheet.rowCount, attendance.length + 1);
  assert.deepEqual(attendanceSheet.getRow(2).values.slice(1), [
    "ART 123-X",
    "Mar 18, 2042",
    "Late",
  ]);
});

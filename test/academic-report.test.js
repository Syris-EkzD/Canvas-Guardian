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

const longAssignmentName =
  "Submitted study with a deliberately long activity name for wrapping";

const assignments = [
  {
    id: "501",
    courseId: "9001",
    course: "ART 123-X",
    name: longAssignmentName,
    dueAt: "2026-07-14T01:00:00Z",
    submitted: true,
    excused: false,
    grade: "23",
    score: 23,
    pointsPossible: 25,
    gradingType: "points",
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
    score: null,
    pointsPossible: null,
    gradingType: null,
  },
  {
    id: "503",
    courseId: "9001",
    course: "ART 123-X",
    name: "Excused exercise",
    dueAt: null,
    submitted: false,
    excused: true,
    grade: null,
    score: null,
    pointsPossible: 10,
    gradingType: "points",
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
    score: 78,
    pointsPossible: 100,
    gradingType: "percent",
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
    score: 0,
    pointsPossible: 20,
    gradingType: "points",
  },
  {
    id: "602",
    courseId: "9002",
    course: "SCI 456-Y",
    name: "Roll Call Attendance",
    dueAt: null,
    submitted: true,
    excused: false,
    grade: "100%",
    score: 100,
    pointsPossible: 100,
    gradingType: "percent",
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
  {
    courseId: "9999",
    courseCode: "AAA 100-Z",
    classDate: "2042-04-01",
    status: "present",
  },
];

test("builds normal assignment rows with Canvas values and excludes Roll Call", () => {
  assert.deepEqual(buildAssignmentRows(assignments), [
    {
      course: "ART 123-X",
      assignment: longAssignmentName,
      dueDate: "Jul 14, 2026, 9:00 AM",
      status: "Submitted",
      score: 23,
      pointsPossible: 25,
      grade: "23",
    },
    {
      course: "ART 123-X",
      assignment: "Pending project",
      dueDate: null,
      status: "Pending",
      score: null,
      pointsPossible: null,
      grade: null,
    },
    {
      course: "ART 123-X",
      assignment: "Excused exercise",
      dueDate: null,
      status: "Excused",
      score: null,
      pointsPossible: 10,
      grade: null,
    },
    {
      course: "SCI 456-Y",
      assignment: "Lab notes",
      dueDate: "Jul 21, 2026, 12:00 AM",
      status: "Pending",
      score: 0,
      pointsPossible: 20,
      grade: "",
    },
  ]);
});

test("sorts attendance rows by course and date with readable statuses", () => {
  assert.deepEqual(buildAttendanceRows(attendance), [
    { course: "AAA 100-Z", classDate: "Apr 1, 2042", status: "Present" },
    { course: "ART 123-X", classDate: "Mar 4, 2042", status: "Present" },
    { course: "ART 123-X", classDate: "Mar 11, 2042", status: "Absent" },
    { course: "ART 123-X", classDate: "Mar 18, 2042", status: "Late" },
  ]);
});

test("summarizes activities separately from Roll Call and detailed attendance", () => {
  assert.deepEqual(buildSummaryRows(assignments, attendance), [
    {
      course: "ART 123-X",
      totalActivities: 3,
      submitted: 1,
      pending: 1,
      excused: 1,
      graded: 1,
      canvasAttendanceGrade: "78%",
      attendanceRecords: 3,
      present: 1,
      absent: 1,
      late: 1,
      attendanceFrom: "Mar 4, 2042",
      attendanceThrough: "Mar 18, 2042",
    },
    {
      course: "SCI 456-Y",
      totalActivities: 1,
      submitted: 0,
      pending: 1,
      excused: 0,
      graded: 0,
      canvasAttendanceGrade: "100%",
      attendanceRecords: null,
      present: null,
      absent: null,
      late: null,
      attendanceFrom: null,
      attendanceThrough: null,
    },
  ]);
});

test("excludes every Roll Call state from academic activity counts", () => {
  const rollCallVariants = [
    {
      courseId: "9100",
      course: "HUM 100-Q",
      name: "roll call attendance",
      submitted: false,
      excused: false,
      grade: null,
    },
    {
      courseId: "9100",
      course: "HUM 100-Q",
      name: "Roll Call Attendance",
      submitted: true,
      excused: true,
      grade: "60%",
    },
  ];

  assert.deepEqual(buildSummaryRows(rollCallVariants, []), [
    {
      course: "HUM 100-Q",
      totalActivities: 0,
      submitted: 0,
      pending: 0,
      excused: 0,
      graded: 0,
      canvasAttendanceGrade: "60%",
      attendanceRecords: null,
      present: null,
      absent: null,
      late: null,
      attendanceFrom: null,
      attendanceThrough: null,
    },
  ]);
});

test("creates the required workbook schema and wraps assignment names", async () => {
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
    assert.deepEqual(worksheet.getRow(1).values.slice(1), expectedHeaders);
    assert.equal(worksheet.getRow(1).font.bold, true);
    assert.equal(worksheet.views[0].state, "frozen");
    assert.equal(worksheet.views[0].ySplit, 1);
    assert.ok(worksheet.autoFilter);
  }

  const assignmentSheet = reloaded.getWorksheet("Assignments");
  assert.equal(assignmentSheet.rowCount, 5);
  assert.deepEqual(assignmentSheet.getRow(2).values.slice(1), [
    "ART 123-X",
    longAssignmentName,
    "Jul 14, 2026, 9:00 AM",
    "Submitted",
    23,
    25,
    "23",
  ]);
  assert.equal(assignmentSheet.getCell("B2").alignment.wrapText, true);
  assert.ok(assignmentSheet.getRow(2).height > 18);
  assert.equal(assignmentSheet.getCell("E3").value, null);
  assert.equal(assignmentSheet.getCell("F3").value, null);
  assert.equal(assignmentSheet.getCell("G3").value, null);

  const summarySheet = reloaded.getWorksheet("Summary");
  assert.equal(summarySheet.getCell("G3").value, "100%");
  assert.equal(summarySheet.getCell("H3").value, null);
  assert.equal(summarySheet.getCell("L3").value, null);

  const attendanceSheet = reloaded.getWorksheet("Attendance");
  assert.equal(attendanceSheet.rowCount, attendance.length + 1);
  assert.deepEqual(attendanceSheet.getRow(2).values.slice(1), [
    "AAA 100-Z",
    "Apr 1, 2042",
    "Present",
  ]);
});

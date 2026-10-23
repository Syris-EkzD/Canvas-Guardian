const { test } = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");

const {
  buildAssignmentRows,
  buildAttendanceRows,
  buildSummaryRows,
  calculatePercentage,
  createAcademicWorkbook,
  isRollCallAssignment,
  sheetDefinitions,
} = require("../src/academic-report");

const longAssignmentName =
  "Submitted study with a deliberately long activity name for wrapping";
const reportNow = new Date("2026-07-15T00:00:00.000Z");

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
    submissionTypes: ["external_tool"],
    externalToolUrl: "https://rollcall-sin.instructure.com/launch",
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
    submissionTypes: ["external_tool"],
    externalToolUrl: "https://rollcall-sin.instructure.com/launch",
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
  const rows = buildAssignmentRows(assignments, reportNow);
  assert.deepEqual(rows.map((row) => row.assignment), [
    longAssignmentName, "Excused exercise", "Pending project", "Lab notes",
  ]);
  assert.equal(rows[0].dueDate.toISOString(), "2026-07-14T09:00:00.000Z");
  assert.deepEqual([rows[0].status, rows[0].grade, rows[0].percentage], ["Submitted", "23", 0.92]);
  assert.deepEqual([rows[1].status, rows[1].dueDate, rows[1].percentage], ["Excused", null, null]);
  assert.deepEqual([rows[2].status, rows[2].score], ["Pending", null]);
  assert.deepEqual([rows[3].status, rows[3].score, rows[3].percentage], ["Pending", 0, null]);
});

test("calculates Excel-compatible assignment percentage values", () => {
  assert.equal(calculatePercentage(23, 25), 0.92);
  assert.equal(calculatePercentage(0, 20), 0);
  assert.equal(calculatePercentage(null, 20), null);
  assert.equal(calculatePercentage(10, null), null);
  assert.equal(calculatePercentage(10, 0), null);
});

test("sorts attendance rows by course and date with readable statuses", () => {
  assert.deepEqual(buildAttendanceRows(attendance).map((row) => [
    row.course, row.classDate.toISOString().slice(0, 10), row.status,
  ]), [
    ["AAA 100-Z", "2042-04-01", "Present"],
    ["ART 123-X", "2042-03-04", "Present"],
    ["ART 123-X", "2042-03-11", "Absent"],
    ["ART 123-X", "2042-03-18", "Late"],
  ]);
});

test("summarizes activities separately from Roll Call and detailed attendance", () => {
  const [art, science] = buildSummaryRows(assignments, attendance, reportNow);
  assert.deepEqual([art.totalActivities, art.submitted, art.pending, art.excused, art.graded], [3, 1, 1, 1, 1]);
  assert.deepEqual([art.upcoming, art.overdue, art.canvasAttendanceGrade], [0, 0, "78%"]);
  assert.deepEqual([art.attendanceRecords, art.present, art.absent, art.late], [3, 1, 1, 1]);
  assert.equal(art.attendedPercentage, 2 / 3);
  assert.equal(art.attendanceFrom.toISOString(), "2042-03-04T00:00:00.000Z");
  assert.equal(art.attendanceThrough.toISOString(), "2042-03-18T00:00:00.000Z");
  assert.deepEqual([science.totalActivities, science.pending, science.graded, science.upcoming], [1, 1, 0, 1]);
  assert.equal(science.canvasAttendanceGrade, "100%");
  assert.equal(science.attendanceRecords, null);
  assert.equal(science.attendedPercentage, null);
});

test("gives excused normal activities precedence over submitted in the summary", () => {
  const excusedSubmittedAssignment = {
    courseId: "9200",
    course: "ENG 200-A",
    name: "Excused but submitted essay",
    submitted: true,
    excused: true,
    grade: "95",
    score: 95,
    pointsPossible: 100,
  };

  const row = buildSummaryRows([excusedSubmittedAssignment], [])[0];
  assert.deepEqual([row.submitted, row.pending, row.excused, row.graded, row.upcoming, row.overdue], [0, 0, 1, 1, 0, 0]);
  assert.equal(row.attendedPercentage, null);
  assert.equal(buildAssignmentRows([excusedSubmittedAssignment])[0].status, "Excused");
});

test("identifies Roll Call from Instructure external-tool metadata", () => {
  for (const externalToolUrl of [
    "https://rollcall-sin.instructure.com/launch",
    "https://rollcall.instructure.com/launch",
    "https://rollcall-us-east.instructure.com/launch",
  ]) {
    assert.equal(
      isRollCallAssignment({
        name: "Daily Attendance",
        submissionTypes: ["external_tool"],
        externalToolUrl,
      }),
      true
    );
  }

  for (const assignment of [
    {
      name: "Roll Call Attendance",
      submissionTypes: [],
      externalToolUrl: null,
    },
    {
      name: "Roll Call Attendance",
      submissionTypes: ["external_tool"],
      externalToolUrl: "https://lti.example.edu/launch",
    },
    {
      name: "Roll Call Attendance",
      submissionTypes: ["external_tool"],
      externalToolUrl: "not a URL",
    },
    {
      name: "Normal assignment",
      submissionTypes: ["online_upload"],
      externalToolUrl: null,
    },
    {
      name: "Roll Call Attendance",
      submissionTypes: ["external_tool"],
      externalToolUrl:
        "https://rollcall-sin.instructure.com.evil.example/launch",
    },
  ]) {
    assert.equal(isRollCallAssignment(assignment), false);
  }
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
      submissionTypes: ["external_tool"],
      externalToolUrl: "https://rollcall-sin.instructure.com/launch",
    },
    {
      courseId: "9100",
      course: "HUM 100-Q",
      name: "Roll Call Attendance",
      submitted: true,
      excused: true,
      grade: "60%",
      submissionTypes: ["external_tool"],
      externalToolUrl: "https://rollcall-sin.instructure.com/launch",
    },
  ];

  const row = buildSummaryRows(rollCallVariants, [])[0];
  assert.deepEqual([row.totalActivities, row.submitted, row.pending, row.excused, row.graded], [0, 0, 0, 0, 0]);
  assert.equal(row.canvasAttendanceGrade, "60%");
  assert.equal(row.attendanceRecords, null);
});

test("creates the required workbook schema and wraps assignment names", async () => {
  const workbook = createAcademicWorkbook(assignments, attendance, reportNow);
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
    new Date("2026-07-14T09:00:00.000Z"),
    "Submitted",
    "23",
    23,
    25,
    0.92,
  ]);
  assert.equal(assignmentSheet.getCell("H2").numFmt, "0.##%");
  assert.equal(assignmentSheet.getCell("C2").numFmt, "mmm d, yyyy h:mm AM/PM");
  assert.equal(assignmentSheet.getCell("B2").alignment.wrapText, true);
  assert.ok(assignmentSheet.getRow(2).height > 18);
  assert.equal(assignmentSheet.getCell("E3").value, null);
  assert.equal(assignmentSheet.getCell("F3").value, null);
  assert.equal(assignmentSheet.getCell("H3").value, null);

  const summarySheet = reloaded.getWorksheet("Summary");
  assert.equal(summarySheet.getCell("I3").value, "100%");
  assert.equal(summarySheet.getCell("J3").value, null);
  assert.equal(summarySheet.getCell("O3").value, null);
  assert.equal(summarySheet.getCell("N2").numFmt, "0.0%");

  const attendanceSheet = reloaded.getWorksheet("Attendance");
  assert.equal(attendanceSheet.rowCount, attendance.length + 1);
  assert.deepEqual(attendanceSheet.getRow(2).values.slice(1), [
    "AAA 100-Z",
    new Date("2042-04-01T00:00:00.000Z"),
    "Present",
  ]);
  assert.equal(attendanceSheet.getCell("B2").numFmt, "mmm d, yyyy");
});

test("counts only pending due dates within the rolling seven-day window", () => {
  const now = new Date("2026-10-23T15:59:00.000Z"); // 11:59 PM in Manila
  const item = (id, dueAt, changes = {}) => ({
    id: String(id), courseId: "1", course: "ART 100", name: `Task ${id}`,
    dueAt, submitted: false, excused: false, grade: null, ...changes,
  });
  const rows = [
    item(1, "2026-10-23T15:58:59.999Z"),
    item(2, now.toISOString()),
    item(3, "2026-10-23T16:00:00.000Z"),
    item(4, new Date(now.getTime() + 7 * 86400000).toISOString()),
    item(5, new Date(now.getTime() + 7 * 86400000 + 1).toISOString()),
    item(6, null),
    item(7, "2026-10-23T15:58:59.999Z", { submitted: true }),
    item(8, "2026-10-23T15:58:59.999Z", { excused: true }),
  ];

  const summary = buildSummaryRows(rows, [], now)[0];
  assert.deepEqual([summary.totalActivities, summary.pending, summary.submitted, summary.excused], [8, 6, 1, 1]);
  assert.deepEqual([summary.overdue, summary.upcoming], [1, 3]);
  const assignmentRows = buildAssignmentRows(rows, now);
  assert.equal(assignmentRows.find((row) => row.assignment === "Task 1").status, "Overdue");
  assert.equal(assignmentRows.find((row) => row.assignment === "Task 7").status, "Submitted");
  assert.equal(assignmentRows.find((row) => row.assignment === "Task 8").status, "Excused");
  assert.equal(assignmentRows.find((row) => row.assignment === "Task 3").dueDate.toISOString(), "2026-10-24T00:00:00.000Z");
  assert.equal(assignmentRows.at(-1).dueDate, null);
});

test("exports safe text, direct links, typed dates, and blank ungraded percentages", async () => {
  const hostile = [{
    id: "1", courseId: "1", course: "=SUM(1,1)", name: " +CMD()",
    dueAt: "2026-10-24T16:00:00Z", submitted: false, excused: false,
    grade: null, score: 0, pointsPossible: 10,
    htmlUrl: "https://canvas.example/courses/1/assignments/1",
  }];
  const records = [{ courseId: "1", sectionId: "2", courseCode: "@SUM(1,1)", classDate: "2026-10-24", status: "late" }];
  const workbook = createAcademicWorkbook(hostile, records, new Date("2026-10-24T00:00:00Z"));
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(await workbook.xlsx.writeBuffer());
  const summary = loaded.getWorksheet("Summary");
  const assignmentsSheet = loaded.getWorksheet("Assignments");
  const attendanceSheet = loaded.getWorksheet("Attendance");

  assert.equal(summary.getCell("A2").value, "'=SUM(1,1)");
  assert.equal(summary.getCell("N2").value, 1);
  assert.equal(summary.getCell("N2").numFmt, "0.0%");
  assert.equal(assignmentsSheet.getCell("B2").value, "' +CMD()");
  assert.equal(assignmentsSheet.getCell("F2").value, 0);
  assert.equal(assignmentsSheet.getCell("H2").value, null);
  assert.deepEqual(assignmentsSheet.getCell("I2").value, {
    text: "Open in Canvas", hyperlink: hostile[0].htmlUrl,
  });
  assert.equal(assignmentsSheet.getCell("C2").value.toISOString(), "2026-10-25T00:00:00.000Z");
  assert.equal(attendanceSheet.getCell("A2").value, "'@SUM(1,1)");
  assert.equal(attendanceSheet.getCell("B2").value.toISOString(), "2026-10-24T00:00:00.000Z");
  assert.equal(attendanceSheet.getCell("C2").value, "Late");
});

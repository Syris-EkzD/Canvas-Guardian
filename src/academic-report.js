const ExcelJS = require("exceljs");

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function safeSpreadsheetText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return /^[\s\u0000-\u001f]*[=+\-@]/.test(text) ? `'${text}` : text;
}

function toManilaExcelDate(value) {
  return value ? new Date(new Date(value).getTime() + MANILA_OFFSET_MS) : null;
}

function toExcelClassDate(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

const sheetDefinitions = {
  Summary: [
    { header: "Course", key: "course", width: 22 },
    { header: "Total Activities", key: "totalActivities", width: 18 },
    { header: "Submitted", key: "submitted", width: 12 },
    { header: "Pending", key: "pending", width: 12 },
    { header: "Upcoming 7 Days", key: "upcoming", width: 18 },
    { header: "Overdue Pending", key: "overdue", width: 19 },
    { header: "Excused", key: "excused", width: 12 },
    { header: "Graded", key: "graded", width: 12 },
    {
      header: "Canvas Attendance Grade",
      key: "canvasAttendanceGrade",
      width: 24,
    },
    { header: "Attendance Records", key: "attendanceRecords", width: 20 },
    { header: "Present", key: "present", width: 11 },
    { header: "Absent", key: "absent", width: 11 },
    { header: "Late", key: "late", width: 11 },
    { header: "Attended %", key: "attendedPercentage", width: 16 },
    { header: "Attendance From", key: "attendanceFrom", width: 18 },
    { header: "Attendance Through", key: "attendanceThrough", width: 20 },
  ],
  Assignments: [
    { header: "Course", key: "course", width: 22 },
    { header: "Assignment", key: "assignment", width: 42 },
    { header: "Due Date", key: "dueDate", width: 25 },
    { header: "Status", key: "status", width: 19 },
    { header: "Canvas Grade", key: "grade", width: 18 },
    { header: "Score", key: "score", width: 12 },
    { header: "Points Possible", key: "pointsPossible", width: 17 },
    { header: "Percentage", key: "percentage", width: 14 },
    { header: "Canvas Link", key: "canvasLink", width: 19 },
  ],
  Attendance: [
    { header: "Course", key: "course", width: 22 },
    { header: "Class Date", key: "classDate", width: 18 },
    { header: "Status", key: "status", width: 12 },
  ],
};

function isRollCallAssignment(assignment) {
  if (!assignment.submissionTypes?.includes("external_tool")) {
    return false;
  }

  try {
    const { hostname } = new URL(assignment.externalToolUrl);
    return /^rollcall(?:-[a-z0-9-]+)?\.instructure\.com$/.test(hostname);
  } catch {
    return false;
  }
}

function getAssignmentStatus(assignment, now = new Date()) {
  if (assignment.excused === true) {
    return "Excused";
  }

  if (assignment.submitted === true) {
    return "Submitted";
  }

  return assignment.dueAt && new Date(assignment.dueAt) < now
    ? "Overdue"
    : "Pending";
}

function formatAttendanceStatus(status) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function calculatePercentage(score, pointsPossible) {
  if (
    score === null ||
    score === undefined ||
    pointsPossible === null ||
    pointsPossible === undefined ||
    pointsPossible <= 0
  ) {
    return null;
  }

  return score / pointsPossible;
}

function buildAssignmentRows(assignments, now = new Date()) {
  return assignments
    .filter((assignment) => !isRollCallAssignment(assignment))
    .sort((left, right) =>
      String(left.course).localeCompare(String(right.course)) ||
      (left.dueAt === null || left.dueAt === undefined ? Infinity : Date.parse(left.dueAt)) -
        (right.dueAt === null || right.dueAt === undefined ? Infinity : Date.parse(right.dueAt)) ||
      String(left.name).localeCompare(String(right.name)) ||
      String(left.id).localeCompare(String(right.id))
    )
    .map((assignment) => ({
      course: safeSpreadsheetText(assignment.course),
      assignment: safeSpreadsheetText(assignment.name),
      dueDate: toManilaExcelDate(assignment.dueAt),
      status: getAssignmentStatus(assignment, now),
      grade: safeSpreadsheetText(assignment.grade),
      score: assignment.score ?? null,
      pointsPossible: assignment.pointsPossible ?? null,
      percentage: assignment.grade === null || assignment.grade === undefined || assignment.grade === ""
        ? null
        : calculatePercentage(assignment.score, assignment.pointsPossible),
      canvasLink: /^https?:\/\//i.test(assignment.htmlUrl ?? "")
        ? { text: "Open in Canvas", hyperlink: assignment.htmlUrl }
        : null,
    }));
}

function buildAttendanceRows(attendance) {
  return [...attendance]
    .sort(
      (left, right) =>
        left.courseCode.localeCompare(right.courseCode) ||
        left.classDate.localeCompare(right.classDate)
    )
    .map((record) => ({
      course: safeSpreadsheetText(record.courseCode),
      classDate: toExcelClassDate(record.classDate),
      status: formatAttendanceStatus(record.status),
    }));
}

function aggregateAttendanceByCourse(attendance) {
  const summaries = new Map();

  for (const record of attendance) {
    let summary = summaries.get(record.courseId);

    if (!summary) {
      summary = {
        attendanceRecords: 0,
        present: 0,
        absent: 0,
        late: 0,
        firstDate: record.classDate,
        lastDate: record.classDate,
      };
      summaries.set(record.courseId, summary);
    }

    summary.attendanceRecords += 1;
    summary[record.status] += 1;

    if (record.classDate < summary.firstDate) {
      summary.firstDate = record.classDate;
    }

    if (record.classDate > summary.lastDate) {
      summary.lastDate = record.classDate;
    }
  }

  return summaries;
}

function buildSummaryRows(assignments, attendance, now = new Date()) {
  const attendanceByCourse = aggregateAttendanceByCourse(attendance);
  const courseRows = new Map();

  for (const assignment of assignments) {
    let row = courseRows.get(assignment.courseId);

    if (!row) {
      const attendanceSummary = attendanceByCourse.get(assignment.courseId);
      row = {
        course: safeSpreadsheetText(assignment.course),
        totalActivities: 0,
        submitted: 0,
        pending: 0,
        upcoming: 0,
        overdue: 0,
        excused: 0,
        graded: 0,
        canvasAttendanceGrade: null,
        attendanceRecords: attendanceSummary?.attendanceRecords ?? null,
        present: attendanceSummary?.present ?? null,
        absent: attendanceSummary?.absent ?? null,
        late: attendanceSummary?.late ?? null,
        attendedPercentage: attendanceSummary
          ? (attendanceSummary.present + attendanceSummary.late) /
            attendanceSummary.attendanceRecords
          : null,
        attendanceFrom: attendanceSummary
          ? toExcelClassDate(attendanceSummary.firstDate)
          : null,
        attendanceThrough: attendanceSummary
          ? toExcelClassDate(attendanceSummary.lastDate)
          : null,
      };
      courseRows.set(assignment.courseId, row);
    }

    if (isRollCallAssignment(assignment)) {
      row.canvasAttendanceGrade = safeSpreadsheetText(assignment.grade);
      continue;
    }

    row.totalActivities += 1;

    if (assignment.excused === true) {
      row.excused += 1;
    } else if (assignment.submitted === true) {
      row.submitted += 1;
    } else {
      row.pending += 1;
      if (assignment.dueAt) {
        const dueTime = new Date(assignment.dueAt).getTime();
        if (dueTime < now.getTime()) {
          row.overdue += 1;
        } else if (dueTime <= now.getTime() + WEEK_MS) {
          row.upcoming += 1;
        }
      }
    }

    if (
      assignment.grade !== null &&
      assignment.grade !== undefined &&
      assignment.grade !== ""
    ) {
      row.graded += 1;
    }
  }

  return [...courseRows.values()].sort((left, right) =>
    left.course.localeCompare(right.course)
  );
}

function addReportSheet(workbook, name, rows) {
  const worksheet = workbook.addWorksheet(name, {
    views: [{ state: "frozen", ySplit: 1, showGridLines: false }],
  });
  worksheet.columns = sheetDefinitions[name];
  if (name === "Assignments") {
    worksheet.getColumn("percentage").numFmt = "0.##%";
    worksheet.getColumn("dueDate").numFmt = "mmm d, yyyy h:mm AM/PM";
  }
  if (name === "Summary") {
    worksheet.getColumn("attendedPercentage").numFmt = "0.0%";
    worksheet.getColumn("attendanceFrom").numFmt = "mmm d, yyyy";
    worksheet.getColumn("attendanceThrough").numFmt = "mmm d, yyyy";
  }
  if (name === "Attendance") {
    worksheet.getColumn("classDate").numFmt = "mmm d, yyyy";
  }

  worksheet.addRows(rows);
  worksheet.autoFilter = {
    from: "A1",
    to: worksheet.getRow(1).getCell(worksheet.columnCount).address,
  };
  worksheet.properties.defaultRowHeight = 18;
  worksheet.getRow(1).height = 22;
  worksheet.getRow(1).font = {
    name: "Arial",
    size: 10,
    bold: true,
    color: { argb: "FFFFFFFF" },
  };
  worksheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1F4E78" },
  };
  worksheet.getRow(1).alignment = {
    horizontal: "center",
    vertical: "middle",
  };

  worksheet.eachRow((row, rowNumber) => {
    row.eachCell((cell) => {
      cell.font = {
        ...cell.font,
        name: "Arial",
        size: 10,
      };
      cell.alignment = {
        ...cell.alignment,
        vertical: "middle",
      };
    });

    if (rowNumber > 1) {
      if (name === "Assignments") {
        const assignmentCell = row.getCell(2);
        const assignmentLength = String(assignmentCell.value ?? "").length;
        const estimatedLines = Math.max(1, Math.ceil(assignmentLength / 42));
        assignmentCell.alignment = {
          vertical: "middle",
          wrapText: true,
        };
        row.height = Math.min(54, estimatedLines * 18);
        const linkCell = row.getCell("canvasLink");
        if (linkCell.value) {
          linkCell.font = { name: "Arial", size: 10, color: { argb: "FF0563C1" }, underline: true };
        }
      } else {
        row.height = 18;
      }
    }
  });

  return worksheet;
}

function createAcademicWorkbook(assignments, attendance, now = new Date()) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Canvas Guardian";
  workbook.created = new Date();
  workbook.modified = new Date();

  addReportSheet(
    workbook,
    "Summary",
    buildSummaryRows(assignments, attendance, now)
  );
  addReportSheet(workbook, "Assignments", buildAssignmentRows(assignments, now));
  addReportSheet(workbook, "Attendance", buildAttendanceRows(attendance));

  return workbook;
}

module.exports = {
  buildAssignmentRows,
  buildAttendanceRows,
  buildSummaryRows,
  calculatePercentage,
  createAcademicWorkbook,
  isRollCallAssignment,
  sheetDefinitions,
};

const ExcelJS = require("exceljs");

const dueDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Manila",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const attendanceDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Manila",
  month: "short",
  day: "numeric",
  year: "numeric",
});

const sheetDefinitions = {
  Summary: [
    { header: "Course", key: "course", width: 22 },
    { header: "Total Activities", key: "totalActivities", width: 18 },
    { header: "Submitted", key: "submitted", width: 12 },
    { header: "Pending", key: "pending", width: 12 },
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
    { header: "Attendance From", key: "attendanceFrom", width: 18 },
    { header: "Attendance Through", key: "attendanceThrough", width: 20 },
  ],
  Assignments: [
    { header: "Course", key: "course", width: 22 },
    { header: "Assignment", key: "assignment", width: 42 },
    { header: "Due Date", key: "dueDate", width: 25 },
    { header: "Status", key: "status", width: 19 },
    { header: "Score", key: "score", width: 12 },
    { header: "Points Possible", key: "pointsPossible", width: 17 },
    { header: "Percentage", key: "percentage", width: 14 },
  ],
  Attendance: [
    { header: "Course", key: "course", width: 22 },
    { header: "Class Date", key: "classDate", width: 18 },
    { header: "Status", key: "status", width: 12 },
  ],
};

function isRollCallAssignment(assignment) {
  return assignment.name.trim().toLowerCase() === "roll call attendance";
}

function getAssignmentStatus(assignment) {
  if (assignment.excused === true) {
    return "Excused";
  }

  if (assignment.submitted === true) {
    return "Submitted";
  }

  return "Pending";
}

function formatDueDate(value) {
  if (value === null || value === undefined) {
    return null;
  }

  return dueDateFormatter.format(new Date(value));
}

function formatAttendanceDate(value) {
  return attendanceDateFormatter.format(new Date(`${value}T00:00:00+08:00`));
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

function buildAssignmentRows(assignments) {
  return assignments
    .filter((assignment) => !isRollCallAssignment(assignment))
    .map((assignment) => ({
      course: assignment.course,
      assignment: assignment.name,
      dueDate: formatDueDate(assignment.dueAt),
      status: getAssignmentStatus(assignment),
      score: assignment.score ?? null,
      pointsPossible: assignment.pointsPossible ?? null,
      percentage: calculatePercentage(
        assignment.score,
        assignment.pointsPossible
      ),
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
      course: record.courseCode,
      classDate: formatAttendanceDate(record.classDate),
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

function buildSummaryRows(assignments, attendance) {
  const attendanceByCourse = aggregateAttendanceByCourse(attendance);
  const courseRows = new Map();

  for (const assignment of assignments) {
    let row = courseRows.get(assignment.courseId);

    if (!row) {
      const attendanceSummary = attendanceByCourse.get(assignment.courseId);
      row = {
        course: assignment.course,
        totalActivities: 0,
        submitted: 0,
        pending: 0,
        excused: 0,
        graded: 0,
        canvasAttendanceGrade: null,
        attendanceRecords: attendanceSummary?.attendanceRecords ?? null,
        present: attendanceSummary?.present ?? null,
        absent: attendanceSummary?.absent ?? null,
        late: attendanceSummary?.late ?? null,
        attendanceFrom: attendanceSummary
          ? formatAttendanceDate(attendanceSummary.firstDate)
          : null,
        attendanceThrough: attendanceSummary
          ? formatAttendanceDate(attendanceSummary.lastDate)
          : null,
      };
      courseRows.set(assignment.courseId, row);
    }

    if (isRollCallAssignment(assignment)) {
      row.canvasAttendanceGrade = assignment.grade ?? null;
      continue;
    }

    row.totalActivities += 1;

    if (assignment.submitted === true) {
      row.submitted += 1;
    }

    if (assignment.excused === true) {
      row.excused += 1;
    } else if (assignment.submitted !== true) {
      row.pending += 1;
    }

    if (
      assignment.grade !== null &&
      assignment.grade !== undefined &&
      assignment.grade !== ""
    ) {
      row.graded += 1;
    }
  }

  return [...courseRows.values()];
}

function addReportSheet(workbook, name, rows) {
  const worksheet = workbook.addWorksheet(name, {
    views: [{ state: "frozen", ySplit: 1, showGridLines: false }],
  });
  worksheet.columns = sheetDefinitions[name];
    if (name === "Assignments") {
    worksheet.getColumn("percentage").numFmt = "0.##%";
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
      } else {
        row.height = 18;
      }
    }
  });

  return worksheet;
}

function createAcademicWorkbook(assignments, attendance) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Canvas Guardian";
  workbook.created = new Date();
  workbook.modified = new Date();

  addReportSheet(
    workbook,
    "Summary",
    buildSummaryRows(assignments, attendance)
  );
  addReportSheet(workbook, "Assignments", buildAssignmentRows(assignments));
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

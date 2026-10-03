const outputColumns = [
  "Course",
  "Assignment",
  "Due Date",
  "Status",
  "Attendance Records",
  "Present",
  "Absent",
  "Late",
  "Attendance From",
  "Attendance Through",
];

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

function aggregateAttendanceByCourse(attendance) {
  const summaries = new Map();

  for (const record of attendance) {
    let summary = summaries.get(record.courseId);

    if (!summary) {
      summary = {
        attendanceRecords: 0,
        presentCount: 0,
        absentCount: 0,
        lateCount: 0,
        attendanceFirstDate: record.classDate,
        attendanceLastDate: record.classDate,
      };
      summaries.set(record.courseId, summary);
    }

    summary.attendanceRecords += 1;

    if (record.status === "present") {
      summary.presentCount += 1;
    } else if (record.status === "absent") {
      summary.absentCount += 1;
    } else if (record.status === "late") {
      summary.lateCount += 1;
    }

    if (record.classDate < summary.attendanceFirstDate) {
      summary.attendanceFirstDate = record.classDate;
    }

    if (record.classDate > summary.attendanceLastDate) {
      summary.attendanceLastDate = record.classDate;
    }
  }

  return summaries;
}

function mergeAcademicData(assignments, attendanceByCourse) {
  return assignments.flatMap((assignment) => {
    const attendance = attendanceByCourse.get(assignment.courseId);

    if (!attendance) {
      return [];
    }

    return [
      {
        course_id: assignment.courseId,
        course: assignment.course,
        assignment_id: assignment.id,
        assignment_name: assignment.name,
        due_at: assignment.dueAt,
        published: assignment.published,
        submitted: assignment.submitted,
        excused: assignment.excused,
        attendance_records: attendance.attendanceRecords,
        present_count: attendance.presentCount,
        absent_count: attendance.absentCount,
        late_count: attendance.lateCount,
        attendance_first_date: attendance.attendanceFirstDate,
        attendance_last_date: attendance.attendanceLastDate,
      },
    ];
  });
}

function requireMergedRows(rows) {
  if (rows.length === 0) {
    throw new Error("No Canvas assignments matched the attendance course IDs");
  }

  return rows;
}

function getAssignmentStatus(row) {
  if (row.excused === true) {
    return "Excused";
  }

  if (row.assignment_name.trim().toLowerCase() === "roll call attendance") {
    return "Attendance Record";
  }

  if (row.submitted === true) {
    return "Submitted";
  }

  return "Pending";
}

function formatDueDate(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return dueDateFormatter.format(new Date(value));
}

function formatAttendanceDate(value) {
  return attendanceDateFormatter.format(new Date(`${value}T00:00:00+08:00`));
}

function toReportRow(row) {
  return {
    Course: row.course,
    Assignment: row.assignment_name,
    "Due Date": formatDueDate(row.due_at),
    Status: getAssignmentStatus(row),
    "Attendance Records": row.attendance_records,
    Present: row.present_count,
    Absent: row.absent_count,
    Late: row.late_count,
    "Attendance From": formatAttendanceDate(row.attendance_first_date),
    "Attendance Through": formatAttendanceDate(row.attendance_last_date),
  };
}

function encodeCsvValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const text = String(value);

  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}

function formatAcademicCsv(rows) {
  const lines = [outputColumns.join(",")];

  for (const row of rows) {
    const reportRow = toReportRow(row);
    lines.push(
      outputColumns.map((column) => encodeCsvValue(reportRow[column])).join(",")
    );
  }

  return `${lines.join("\n")}\n`;
}

module.exports = {
  aggregateAttendanceByCourse,
  formatAcademicCsv,
  mergeAcademicData,
  outputColumns,
  requireMergedRows,
};

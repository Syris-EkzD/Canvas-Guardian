const outputColumns = [
  "course_id",
  "course",
  "assignment_id",
  "assignment_name",
  "due_at",
  "published",
  "submitted",
  "excused",
  "attendance_records",
  "present_count",
  "absent_count",
  "late_count",
  "attendance_first_date",
  "attendance_last_date",
];

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
    lines.push(
      outputColumns.map((column) => encodeCsvValue(row[column])).join(",")
    );
  }

  return `${lines.join("\n")}\n`;
}

module.exports = {
  aggregateAttendanceByCourse,
  formatAcademicCsv,
  mergeAcademicData,
  outputColumns,
};

const { parse } = require("csv-parse/sync");

const requiredHeaders = [
  "Course ID",
  "SIS Course ID",
  "Course Code",
  "Course Name",
  "Section Name",
  "Section ID",
  "SIS Section ID",
  "Teacher ID",
  "Teacher Name",
  "Student ID",
  "Student Name",
  "Class Date",
  "Attendance",
  "Timestamp",
];
const supportedStatuses = new Set(["present", "absent", "late"]);

function importAttendance(csvText, canvasUserId) {
  let rows;

  try {
    rows = parse(csvText, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
    });
  } catch (error) {
    throw new Error(`Invalid attendance CSV: ${error.message}`);
  }

  if (rows.length === 0) {
    throw new Error("Attendance CSV is empty");
  }

  const headers = rows[0].map((header) => String(header).trim());
  const missingHeaders = requiredHeaders.filter(
    (header) => !headers.includes(header)
  );

  if (missingHeaders.length > 0) {
    throw new Error(
      `Attendance CSV is missing required columns: ${missingHeaders.join(", ")}`
    );
  }

  const indexes = Object.fromEntries(
    requiredHeaders.map((header) => [header, headers.indexOf(header)])
  );
  const requestedUserId = String(canvasUserId);
  const attendance = [];

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const unexpectedValues = row.slice(headers.length);

    if (unexpectedValues.some((value) => String(value).trim() !== "")) {
      throw new Error(
        `Attendance CSV row ${rowIndex + 1} has an unexpected nonempty extra field`
      );
    }

    if (String(row[indexes["Student ID"]] ?? "").trim() !== requestedUserId) {
      continue;
    }

    const normalized = {
      courseId: String(row[indexes["Course ID"]] ?? "").trim(),
      courseCode: String(row[indexes["Course Code"]] ?? "").trim(),
      classDate: String(row[indexes["Class Date"]] ?? "").trim(),
      status: String(row[indexes.Attendance] ?? "").trim().toLowerCase(),
    };

    if (!normalized.courseId || !normalized.classDate || !normalized.status) {
      throw new Error(
        `Attendance CSV row ${rowIndex + 1} is missing required attendance data`
      );
    }

    if (!supportedStatuses.has(normalized.status)) {
      throw new Error(
        `Attendance CSV row ${rowIndex + 1} has unsupported attendance status`
      );
    }

    attendance.push(normalized);
  }

  if (attendance.length === 0) {
    throw new Error(
      "Attendance CSV contains no records for the current Canvas user"
    );
  }

  return attendance;
}

module.exports = { importAttendance, requiredHeaders };

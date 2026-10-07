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

function isValidClassDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const daysInMonth = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1];
}

function getSafeCsvParseError(error) {
  const details = [];

  if (
    typeof error?.code === "string" &&
    /^[A-Z0-9_]+$/.test(error.code)
  ) {
    details.push(`code ${error.code}`);
  }

  if (Number.isInteger(error?.lines) && error.lines > 0) {
    details.push(`line ${error.lines}`);
  }

  if (Number.isInteger(error?.records) && error.records >= 0) {
    details.push(`record ${error.records}`);
  }

  return details.length > 0
    ? `Invalid attendance CSV (${details.join(", ")})`
    : "Invalid attendance CSV";
}

function importAttendance(csvText, canvasUserId) {
  let rows;

  try {
    rows = parse(csvText, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
    });
  } catch (error) {
    throw new Error(getSafeCsvParseError(error));
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
      sectionId: String(row[indexes["Section ID"]] ?? "").trim(),
      courseCode: String(row[indexes["Course Code"]] ?? "").trim(),
      classDate: String(row[indexes["Class Date"]] ?? "").trim(),
      status: String(row[indexes.Attendance] ?? "").trim().toLowerCase(),
    };

    if (
      !normalized.courseId ||
      !normalized.sectionId ||
      !normalized.classDate ||
      !normalized.status
    ) {
      throw new Error(
        `Attendance CSV row ${rowIndex + 1} is missing required attendance data`
      );
    }

    if (!isValidClassDate(normalized.classDate)) {
      throw new Error(
        `Attendance CSV row ${rowIndex + 1} has invalid class date`
      );
    }

    if (!supportedStatuses.has(normalized.status)) {
      throw new Error(
        `Attendance CSV row ${rowIndex + 1} has unsupported attendance status`
      );
    }

    attendance.push(normalized);
  }

  return attendance;
}

module.exports = {
  getSafeCsvParseError,
  importAttendance,
  isValidClassDate,
  requiredHeaders,
};

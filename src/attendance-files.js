const fs = require("node:fs/promises");
const path = require("node:path");

const { importAttendance } = require("./attendance-import");

function getAttendanceEventKey({ courseId, sectionId, classDate }) {
  return `${courseId}\u0000${sectionId}\u0000${classDate}`;
}

function deduplicateAttendance(records) {
  const uniqueRecords = new Map();

  for (const record of records) {
    const key = getAttendanceEventKey(record);

    if (!uniqueRecords.has(key)) {
      uniqueRecords.set(key, record);
    }
  }

  return {
    attendance: [...uniqueRecords.values()],
    duplicateRecordsRemoved: records.length - uniqueRecords.size,
  };
}

async function loadAttendanceFromDirectory(inputDirectory, canvasUserId) {
  const entries = await fs.readdir(inputDirectory, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => entry.isFile() && path.extname(entry.name) === ".csv")
    .map((entry) => entry.name)
    .sort();

  if (filenames.length === 0) {
    throw new Error("No attendance CSV files found in data/input/attendance");
  }

  const records = [];

  for (const filename of filenames) {
    const csvText = await fs.readFile(path.join(inputDirectory, filename), "utf8");
    records.push(...importAttendance(csvText, canvasUserId));
  }

  const result = deduplicateAttendance(records);

  if (result.attendance.length === 0) {
    throw new Error("No attendance records found for the current Canvas user");
  }

  return {
    ...result,
    filesProcessed: filenames.length,
  };
}

module.exports = {
  deduplicateAttendance,
  getAttendanceEventKey,
  loadAttendanceFromDirectory,
};

require("dotenv").config({ quiet: true });

const fs = require("node:fs/promises");
const path = require("node:path");

const { createAcademicWorkbook } = require("./academic-report");
const { loadAttendanceFromDirectory } = require("./attendance-files");
const { getAllActiveCourseAssignments } = require("./canvas-assignments");
const { canvasGet } = require("./canvas-client");

const attendanceDirectory = path.resolve("data/input/attendance");
const outputPath = path.resolve("data/output/academic-report.xlsx");

function validateConfiguration() {
  const missing = ["CANVAS_BASE_URL", "CANVAS_ACCESS_TOKEN"].filter(
    (name) => !process.env[name]
  );

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

function getDateCoverage(attendance) {
  const dates = attendance.map((record) => record.classDate).sort();
  return `${dates[0]} to ${dates[dates.length - 1]}`;
}

async function writeOutput(workbook) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;

  try {
    await workbook.xlsx.writeFile(temporaryPath);
    await fs.rename(temporaryPath, outputPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function run() {
  validateConfiguration();

  const profile = await canvasGet("/api/v1/users/self/profile");

  if (profile.id === null || profile.id === undefined) {
    throw new Error("Canvas profile response did not include a user ID");
  }

  const assignments = await getAllActiveCourseAssignments();
  const {
    attendance,
    filesProcessed,
    duplicateRecordsRemoved,
  } = await loadAttendanceFromDirectory(attendanceDirectory, profile.id);
  const workbook = createAcademicWorkbook(assignments, attendance);

  await writeOutput(workbook);

  console.log(`Academic pipeline complete: ${path.relative(process.cwd(), outputPath)}`);
  console.log(`Canvas assignments: ${assignments.length}`);
  console.log(`Attendance CSV files processed: ${filesProcessed}`);
  console.log(`Attendance records used: ${attendance.length}`);
  console.log(`Duplicate attendance records removed: ${duplicateRecordsRemoved}`);
  console.log(`Attendance date coverage: ${getDateCoverage(attendance)}`);
}

run().catch((error) => {
  console.error(`Academic pipeline failed: ${error.message}`);
  process.exitCode = 1;
});

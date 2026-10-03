require("dotenv").config({ quiet: true });

const fs = require("node:fs/promises");
const path = require("node:path");

const {
  aggregateAttendanceByCourse,
  formatAcademicCsv,
  mergeAcademicData,
} = require("./academic-pipeline");
const { importAttendance } = require("./attendance-import");
const { getAllActiveCourseAssignments } = require("./canvas-assignments");
const { canvasGet } = require("./canvas-client");

const inputPath = path.resolve("data/input/attendance.csv");
const outputPath = path.resolve("data/output/academic-pipeline.csv");

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

async function writeOutput(csvOutput) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;

  try {
    await fs.writeFile(temporaryPath, csvOutput, "utf8");
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
  const csvText = await fs.readFile(inputPath, "utf8");
  const attendance = importAttendance(csvText, profile.id);
  const attendanceByCourse = aggregateAttendanceByCourse(attendance);
  const mergedRows = mergeAcademicData(assignments, attendanceByCourse);
  const csvOutput = formatAcademicCsv(mergedRows);

  await writeOutput(csvOutput);

  console.log(`Academic pipeline complete: ${path.relative(process.cwd(), outputPath)}`);
  console.log(`Merged assignment rows: ${mergedRows.length}`);
  console.log(`Attendance records used: ${attendance.length}`);
  console.log(`Attendance date coverage: ${getDateCoverage(attendance)}`);
}

run().catch((error) => {
  console.error(`Academic pipeline failed: ${error.message}`);
  process.exitCode = 1;
});

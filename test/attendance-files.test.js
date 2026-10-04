const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { requiredHeaders } = require("../src/attendance-import");
const {
  deduplicateAttendance,
  loadAttendanceFromDirectory,
} = require("../src/attendance-files");

const header = requiredHeaders.join(",");

function row({
  courseId = "9001",
  sectionId = "9101",
  courseCode = "ART 123-X",
  studentId = "7001",
  classDate = "2042-03-04",
  attendance = "present",
} = {}) {
  return [
    courseId,
    "SIS-COURSE-X",
    courseCode,
    "Creative Studies",
    "Section X",
    sectionId,
    "SIS-SECTION-X",
    "8001",
    "Instructor Example",
    studentId,
    "Student Alpha",
    classDate,
    attendance,
    `${classDate}T01:02:03Z`,
    "",
  ].join(",");
}

function record({
  courseId = "9001",
  sectionId = "9101",
  courseCode = "ART 123-X",
  classDate = "2042-03-04",
  status = "present",
} = {}) {
  return { courseId, sectionId, courseCode, classDate, status };
}

async function withTemporaryDirectory(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-guardian-"));

  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("deduplicates identical attendance events", () => {
  const first = record();
  const result = deduplicateAttendance([first, { ...first }]);

  assert.deepEqual(result.attendance, [first]);
  assert.equal(result.duplicateRecordsRemoved, 1);
});

test("keeps attendance events from different courses and sections", () => {
  const result = deduplicateAttendance([
    record(),
    record({ courseId: "9002", sectionId: "9101" }),
    record({ sectionId: "9102" }),
  ]);

  assert.equal(result.attendance.length, 3);
  assert.equal(result.duplicateRecordsRemoved, 0);
});

test("uses course, section, and class date for duplicate identity", () => {
  const first = record({ status: "present" });
  const duplicateWithDifferentStatus = record({ status: "absent" });
  const result = deduplicateAttendance([first, duplicateWithDifferentStatus]);

  assert.deepEqual(result.attendance, [first]);
  assert.equal(result.duplicateRecordsRemoved, 1);
});

test("combines multiple exports, skips unmatched files, and deduplicates overlaps", async () => {
  await withTemporaryDirectory(async (directory) => {
    await Promise.all([
      fs.writeFile(
        path.join(directory, "a-july.csv"),
        `${header}\n${row({ attendance: "present" })}`
      ),
      fs.writeFile(
        path.join(directory, "b-full.csv"),
        [
          header,
          row({ attendance: "absent" }),
          row({
            courseId: "9002",
            sectionId: "9201",
            courseCode: "SCI 456-Y",
            classDate: "2042-03-11",
            attendance: "late",
          }),
        ].join("\n")
      ),
      fs.writeFile(
        path.join(directory, "c-other-student.csv"),
        `${header}\n${row({ studentId: "7999" })}`
      ),
    ]);

    const result = await loadAttendanceFromDirectory(directory, "7001");

    assert.equal(result.filesProcessed, 3);
    assert.equal(result.duplicateRecordsRemoved, 1);
    assert.deepEqual(result.attendance, [
      record({ status: "present" }),
      record({
        courseId: "9002",
        sectionId: "9201",
        courseCode: "SCI 456-Y",
        classDate: "2042-03-11",
        status: "late",
      }),
    ]);
  });
});

test("rejects directories with no direct attendance CSV files", async () => {
  await withTemporaryDirectory(async (directory) => {
    const nestedDirectory = path.join(directory, "nested");
    await fs.mkdir(nestedDirectory);
    await fs.writeFile(path.join(nestedDirectory, "attendance.csv"), "ignored");

    await assert.rejects(
      loadAttendanceFromDirectory(directory, "7001"),
      new Error("No attendance CSV files found in data/input/attendance")
    );
  });
});

test("rejects when all valid files have no current-user attendance", async () => {
  await withTemporaryDirectory(async (directory) => {
    await fs.writeFile(
      path.join(directory, "other-student.csv"),
      `${header}\n${row({ studentId: "7999" })}`
    );

    await assert.rejects(
      loadAttendanceFromDirectory(directory, "7001"),
      new Error("No attendance records found for the current Canvas user")
    );
  });
});

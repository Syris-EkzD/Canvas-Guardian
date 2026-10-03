const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  importAttendance,
  requiredHeaders,
} = require("../src/attendance-import");

const header = requiredHeaders.join(",");

function row({
  courseId = "9001",
  courseCode = "ART 123-X",
  studentId = "7001",
  studentName = "Student Alpha",
  classDate = "2042-03-04",
  attendance = "present",
  trailing = "",
} = {}) {
  return [
    courseId,
    "SIS-COURSE-X",
    `"${courseCode}"`,
    "Creative Studies",
    "Section X",
    "9101",
    "SIS-SECTION-X",
    "8001",
    "Instructor Example",
    studentId,
    `"${studentName}"`,
    classDate,
    attendance,
    `${classDate}T01:02:03Z`,
    trailing,
  ].join(",");
}

test("imports quoted Roll Call values, filters by Canvas user, and normalizes statuses", () => {
  const csv = [
    header,
    row({
      courseCode: "ART 123-X, Studio",
      studentName: "Alpha, Student",
      attendance: "PRESENT",
    }),
    row({ studentId: "7002", studentName: "Student Beta" }),
    row({ classDate: "2042-03-11", attendance: "Absent" }),
    row({ classDate: "2042-03-18", attendance: " LATE " }),
  ].join("\n");

  assert.deepEqual(importAttendance(csv, 7001), [
    {
      courseId: "9001",
      courseCode: "ART 123-X, Studio",
      classDate: "2042-03-04",
      status: "present",
    },
    {
      courseId: "9001",
      courseCode: "ART 123-X",
      classDate: "2042-03-11",
      status: "absent",
    },
    {
      courseId: "9001",
      courseCode: "ART 123-X",
      classDate: "2042-03-18",
      status: "late",
    },
  ]);
});

test("tolerates the Roll Call export's trailing empty field", () => {
  assert.equal(importAttendance(`${header}\n${row()}`, "7001").length, 1);
});

test("rejects a trailing nonempty field", () => {
  assert.throws(
    () => importAttendance(`${header}\n${row({ trailing: "unexpected" })}`, "7001"),
    /row 2 has an unexpected nonempty extra field/
  );
});

test("rejects missing required headers", () => {
  const incompleteHeader = requiredHeaders
    .filter((name) => name !== "Class Date")
    .join(",");

  assert.throws(
    () => importAttendance(`${incompleteHeader}\n`, "7001"),
    /missing required columns: Class Date/
  );
});

test("rejects a file with no records for the current Canvas user", () => {
  assert.throws(
    () => importAttendance(`${header}\n${row({ studentId: "7999" })}`, "7001"),
    /no records for the current Canvas user/
  );
});

test("rejects unsupported attendance values for the current user", () => {
  assert.throws(
    () =>
      importAttendance(
        `${header}\n${row({ attendance: "unknown" })}`,
        "7001"
      ),
    /unsupported attendance status/
  );
});

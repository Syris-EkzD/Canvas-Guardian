const { createAcademicWorkbook } = require("./academic-report");
const { importAttendance } = require("./attendance-import");
const { deduplicateAttendance } = require("./attendance-files");
const { getAllActiveCourseAssignments } = require("./canvas-assignments");
const { canvasGet } = require("./canvas-client");

async function getAcademicData(loadAttendance, dependencies = {}, options = {}) {
  const getProfile = dependencies.getProfile || ((requestOptions) => canvasGet("/api/v1/users/self/profile", requestOptions));
  const getAssignments = dependencies.getAssignments || getAllActiveCourseAssignments;
  const profile = await getProfile(options);
  if (profile?.id === null || profile?.id === undefined) {
    throw new Error("Canvas profile response did not include a user ID");
  }

  const attendanceResult = await loadAttendance(profile.id);
  const assignments = await getAssignments(options);
  return {
    ...attendanceResult,
    assignments,
    workbook: createAcademicWorkbook(assignments, attendanceResult.attendance),
  };
}

async function createReportFromCsv(csvText, dependencies, options) {
  return getAcademicData((userId) => {
    const result = deduplicateAttendance(importAttendance(csvText, userId));
    if (result.attendance.length === 0) {
      throw new Error("No attendance records found for the current Canvas user");
    }
    return { ...result, filesProcessed: 1 };
  }, dependencies, options);
}

module.exports = { createReportFromCsv, getAcademicData };

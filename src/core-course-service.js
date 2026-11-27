const { createHash } = require("node:crypto");
const { resolveActivityStatus } = require("./activity-status");
const { CoreError } = require("./core-errors");
const TIMEZONE = "Asia/Manila";

function courseDto(row) {
  return { courseId: row.course_id, courseName: row.course_name, archiveState: row.local_state,
    archivedAt: row.archived_at, stateVersion: row.state_version,
    upstreamPresence: row.upstream_presence, lastSeenAt: row.last_seen_at,
    assignmentFetchedAt: row.assignment_fetched_at };
}
function normalized(row) {
  return { key: row.course_id + ":" + row.assignment_id, courseId: row.course_id,
    id: row.assignment_id, course: row.course_name, name: row.title,
    dueAt: row.due_at, htmlUrl: row.canvas_url, published: row.published === 1,
    submitted: row.submitted === 1, excused: row.excused === null ? null : row.excused === 1 };
}
function assignmentDto(row, overrides) {
  const item = normalized(row);
  return { key: item.key, courseId: item.courseId, assignmentId: item.id,
    title: item.name, dueAt: item.dueAt, canvasUrl: item.htmlUrl,
    published: item.published, submitted: item.submitted, excused: item.excused,
    guardianStatus: resolveActivityStatus(item, key => overrides.get(key)),
    presence: row.presence, lastSeenAt: row.last_seen_at };
}
function page(prefix, items, {limit, offset, revision}) {
  // Equivalent to SHA256(JSON.stringify([...prefix, items])). Stream retained
  // histories so the 100k record cap cannot create a giant JSON allocation.
  const digest = createHash("sha256");
  digest.update(JSON.stringify(prefix).slice(0,-1) + ",[");
  let total = 0;
  const result = [];
  for (const item of items) {
    if (total) digest.update(",");
    digest.update(JSON.stringify(item));
    if (total >= offset && result.length < limit) result.push(item);
    total++;
  }
  const hash = digest.update("]]").digest("hex");
  if (revision !== undefined && revision !== hash) throw new CoreError("VIEW_CHANGED");
  return { page: {limit, offset, total, nextOffset: offset + limit < total ? offset + limit : null, revision: hash},
    items: result };
}
function syncDto(sync, freshness, now) {
  const state = sync.last_success_at === null ? "never"
    : Date.parse(sync.last_success_at) > now ? "stale" : freshness;
  return { lastSuccessAt: sync.last_success_at, lastAttemptAt: sync.last_attempt_at,
    state, lastResult: sync.last_result, errorCode: sync.last_error_code };
}
function courseFreshness(course, sync, now) {
  const fetchedAt = course.assignment_fetched_at;
  const state = fetchedAt === null ? "never"
    : course.local_state === "archived" ? "frozen"
    : course.upstream_presence !== "present" || Date.parse(fetchedAt) > now ||
      sync.state === "stale" ? "stale" : sync.state;
  return { fetchedAt, state };
}
function *assignmentsFor(rows, historical, overrides) {
  for (const row of rows) {
    // Do not expose unpublished assignment metadata in any new read.
    if (row.published !== 1 || !historical && row.presence !== "present") continue;
    yield assignmentDto(row, overrides);
  }
}
function readCourses({academic, accountId, result, route, courseId, query, now}) {
  return academic.read({courseId, includeAssignments: route === "assignments"}, ({sync, courses, assignments, overrides}) => {
    if (sync.generation !== result.generation ||
        (result.state === "stale" ? sync.last_result !== "failed" : sync.last_result !== "success"))
      throw new CoreError("SNAPSHOT_UNAVAILABLE");
    if (!sync.generation) throw result.error || new CoreError("SNAPSHOT_UNAVAILABLE");
    const freshness = syncDto(sync, result.state, now);
    const envelope = {accountId, timezone: TIMEZONE, evaluatedAt: new Date(now).toISOString(), sync: freshness};
    if (route === "courses") {
      const projected = courses.filter(row => (row.upstream_presence === "present") === (query.view === "active")).map(courseDto);
      return {...envelope, ...page([accountId, query.view], projected, query)};
    }
    const course = courses[0];
    if (!course) {
      if (freshness.state === "stale") throw result.error || new CoreError("SNAPSHOT_UNAVAILABLE");
      throw new CoreError("NOT_FOUND");
    }
    if (route === "course") return {...envelope, course: courseDto(course)};
    const historical = course.upstream_presence !== "present";
    return {...envelope, courseId, freshness: courseFreshness(course, freshness, now),
      ...page([accountId, courseId, course.local_state, course.state_version, course.upstream_presence],
        assignmentsFor(assignments, historical, overrides), query)};
  });
}
module.exports = { normalized, readCourses };

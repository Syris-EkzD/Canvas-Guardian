const { normalizeAssignment, activeCoursesPath, assignmentPath } = require("./canvas-assignments");
const { CoreError } = require("./core-errors");

const invalid = () => { throw new CoreError("UPSTREAM_INVALID"); };
function transient(code, retryAfter) {
  const error = new CoreError(code, retryAfter);
  error.allowStale = true;
  return error;
}
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const name = value => typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= 8192;
function canonicalId(value) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) invalid();
  if (!["number", "string"].includes(typeof value) || !/^[1-9]\d{0,63}$/.test(String(value))) invalid();
  return String(value);
}
function timestamp(value) {
  if (value == null) return null;
  if (typeof value !== "string") invalid();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) invalid();
  const [, y, m, d, h, min, sec] = match.map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(y, m - 1, d);
  if (calendar.getUTCMonth() !== m - 1 || calendar.getUTCDate() !== d || h > 23 || min > 59 || sec > 59) invalid();
  return new Date(value).toISOString();
}
function configuredOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new CoreError("ACCOUNT_UNVERIFIED"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new CoreError("ACCOUNT_UNVERIFIED");
  return url.origin;
}
function nextLink(header, current, origin, pathname) {
  if (header == null) return null;
  // Consume the entire header in order. Only top-level parameters can
  // establish a relation; quoted strings and URI targets are opaque here.
  const target = /[ \t]*<([^<>"\\\s\x00-\x1f\x7f]+)>[ \t]*/y;
  const parameter = /;[ \t]*([!#$%&'*+\-.^_\x60|~\w]+)[ \t]*=[ \t]*(?:"((?:[\t\x20\x21\x23-\x5b\x5d-\x7e\x80-\xff]|\\[\t\x20-\x7e\x80-\xff])*)"|([!#$%&'*+\-.^_\x60|~\w]+))[ \t]*/y;
  let cursor = 0, next = null;
  while (true) {
    target.lastIndex = cursor;
    const link = target.exec(header);
    if (!link) invalid();
    cursor = target.lastIndex;
    let relations = null;
    while (header[cursor] === ";") {
      parameter.lastIndex = cursor;
      const param = parameter.exec(header);
      if (!param) invalid();
      cursor = parameter.lastIndex;
      if (param[1].toLowerCase() !== "rel") continue;
      if (relations !== null) invalid();
      const value = param[2] === undefined ? param[3] : param[2].replace(/\\(.)/g, "$1");
      // A relation is a registered name or an absolute URI. Multiple
      // space-separated relation types are valid, but duplicates are ambiguous.
      relations = value.split(/ +/);
      const seen = new Set();
      for (const relation of relations) {
        const registered = /^[a-z][a-z0-9.-]*$/i.test(relation);
        if (!registered) {
          if (!/^[a-z][a-z0-9+.-]*:[a-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/i.test(relation) ||
              /%(?![0-9a-f]{2})/i.test(relation)) invalid();
          try { new URL(relation); } catch { invalid(); }
        }
        const key = registered ? relation.toLowerCase() : relation;
        if (seen.has(key)) invalid();
        seen.add(key);
      }
      relations = seen;
    }
    if (relations === null) invalid();
    if (relations.has("next")) {
      if (next !== null) invalid();
      let url;
      try { url = new URL(link[1], current); } catch { invalid(); }
      if (url.origin !== origin || url.username || url.password || url.hash || url.pathname !== pathname || url.href.length > 8192) invalid();
      next = url.href;
    }
    if (cursor === header.length) return next;
    if (header[cursor] !== ",") invalid();
    cursor++;
    // The next iteration requires a complete link, rejecting empty elements
    // and trailing commas rather than silently accepting a partial list.
  }
}
function safeCanvasUrl(value, origin, courseId, assignmentId) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.origin !== origin || url.username || url.password ||
        url.pathname !== "/courses/" + courseId + "/assignments/" + assignmentId) return null;
    return url.origin + url.pathname;
  } catch { return null; }
}
function createCoreCanvas({ baseUrl, token, profileId, fetchImpl = global.fetch,
  deadlineMs = 60_000, requestMs = 15_000, maxPages = 1000, maxRows = 10_000 }) {
  const origin = configuredOrigin(baseUrl);
  const expected = canonicalId(profileId);
  if (typeof token !== "string" || !token) throw new CoreError("ACCOUNT_UNVERIFIED");

  function operation(signal) {
    const deadline = AbortSignal.timeout(deadlineMs);
    const overall = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let pages = 0, bytes = 0, rows = 0;
    async function get(url) {
      if (++pages > maxPages) invalid();
      const request = AbortSignal.any([overall, AbortSignal.timeout(requestMs)]);
      try {
        const response = await fetchImpl(url, {
          method: "GET", headers: { Authorization: "Bearer " + token, Accept: "application/json" },
          redirect: "manual", signal: request,
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel(); invalid();
        }
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 429) {
            const retry = response.headers.get("retry-after");
            throw transient("SERVICE_UNAVAILABLE", /^\d{1,5}$/.test(retry || "") ? Math.min(60, Math.max(1, Number(retry))) : undefined);
          }
          throw response.status >= 500 ? transient("UPSTREAM_FAILED") : new CoreError("UPSTREAM_FAILED");
        }
        if (response.url && response.url !== url || response.redirected) {
          await response.body?.cancel(); invalid();
        }
        if (!response.body) invalid();
        const reader = response.body.getReader();
        const chunks = [];
        let count = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            count += value.byteLength; bytes += value.byteLength;
            if (count > 2 * 1024 * 1024 || bytes > 64 * 1024 * 1024) invalid();
            chunks.push(Buffer.from(value));
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        let body;
        try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { invalid(); }
        request.throwIfAborted();
        return { body, link: response.headers.get("link") };
      } catch (error) {
        if (request.aborted) throw transient("UPSTREAM_TIMEOUT");
        if (error instanceof CoreError) throw error;
        throw transient("UPSTREAM_FAILED");
      }
    }
    async function verify() {
      const { body, link } = await get(origin + "/api/v1/users/self/profile");
      if (!object(body) || link && nextLink(link, origin, origin, "/api/v1/users/self/profile")) invalid();
      if (canonicalId(body.id) !== expected) throw new CoreError("ACCOUNT_UNVERIFIED");
    }
    async function requestAll(path) {
      const first = new URL(path, origin);
      const courseMatch = /^\/api\/v1\/courses\/([1-9]\d*)\/assignments$/.exec(first.pathname);
      const courses = first.pathname === "/api/v1/courses";
      if (!courses && !courseMatch) invalid();
      const seen = new Set(), ids = new Set(), output = [];
      let url = first.href;
      while (url) {
        overall.throwIfAborted();
        if (seen.has(url)) invalid();
        seen.add(url);
        const { body, link } = await get(url);
        if (!Array.isArray(body)) invalid();
        for (const row of body) {
          if (!object(row)) invalid();
          const id = canonicalId(row.id);
          if (ids.has(id)) invalid();
          ids.add(id);
          if (ids.size > maxRows) invalid();
          if (courses) {
            if (!name(row.course_code || row.name)) invalid();
            output.push({ id, course_code: row.course_code || row.name });
          } else {
            if (++rows > maxRows || !name(row.name) || typeof row.published !== "boolean") invalid();
            if (row.course_id !== undefined && canonicalId(row.course_id) !== courseMatch[1]) invalid();
            const s = row.submission;
            if (s != null && (!object(s) ||
              (s.workflow_state != null && !["unsubmitted", "submitted", "graded", "pending_review"].includes(s.workflow_state)) ||
              (s.assignment_id !== undefined && canonicalId(s.assignment_id) !== id) ||
              (s.user_id !== undefined && canonicalId(s.user_id) !== expected) ||
              (s.missing != null && typeof s.missing !== "boolean") ||
              (s.excused != null && typeof s.excused !== "boolean"))) invalid();
            output.push({ id, name: row.name, published: row.published, due_at: timestamp(row.due_at),
              html_url: safeCanvasUrl(row.html_url, origin, courseMatch[1], id),
              submission: s == null ? null : { submitted_at: timestamp(s.submitted_at), workflow_state: s.workflow_state,
                missing: s.missing, excused: s.excused } });
          }
        }
        url = nextLink(link, url, origin, first.pathname);
      }
      return output;
    }
    return { verify, requestAll, overall };
  }
  async function loadSnapshot(signal) {
      const op = operation(signal);
      try {
        await op.verify();
        const courses = await op.requestAll(activeCoursesPath);
        const items = [];
        for (const course of courses) {
          const assignments = await op.requestAll(assignmentPath(course.id));
          for (const assignment of assignments) items.push(normalizeAssignment(course, assignment));
        }
        op.overall.throwIfAborted();
        return { courses, items };
      } catch (error) {
        if (op.overall.aborted) throw transient("UPSTREAM_TIMEOUT");
        throw error;
      }
  }
  return {
    origin, profileId: expected,
    async verify(signal) { await operation(signal).verify(); },
    loadSnapshot,
    async load(signal) { return (await loadSnapshot(signal)).items; },
  };
}
module.exports = { createCoreCanvas, canonicalId, configuredOrigin };

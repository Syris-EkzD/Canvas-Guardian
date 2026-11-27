const { getAllActiveCourseAssignments } = require("./canvas-assignments");
const { CoreError } = require("./core-errors");

const invalid = () => { throw new CoreError("UPSTREAM_INVALID"); };
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
  // Canvas emits RFC 8288 links. Commas inside a target or quoted parameter
  // are not delimiters. Reject malformed/ambiguous links, not partial results.
  const parts = header.match(/<(?:[^<>]*)>(?:\s*;\s*[\w-]+\s*=\s*(?:"[^"]*"|[^,;\s]+))+\s*(?:,|$)/g);
  if (!parts || parts.join("").replace(/\s/g, "") !== header.replace(/\s/g, "")) {
    // The common separator is comma + space.
    if (!parts || parts.map(x => x.trim()).join("").replace(/\s/g, "") !== header.replace(/\s/g, "")) invalid();
  }
  let next = null;
  for (const part of parts) {
    const target = /^<([^<>]+)>/.exec(part.trim());
    const rels = [...part.matchAll(/;\s*rel\s*=\s*(?:"([^"]+)"|([^,;\s]+))/gi)];
    if (!target || rels.length !== 1) invalid();
    if (!(rels[0][1] || rels[0][2]).split(/\s+/).includes("next")) continue;
    if (next) invalid();
    let url;
    try { url = new URL(target[1], current); } catch { invalid(); }
    if (url.origin !== origin || url.username || url.password || url.hash || url.pathname !== pathname || url.href.length > 8192) invalid();
    next = url.href;
  }
  return next;
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
            throw new CoreError("SERVICE_UNAVAILABLE", /^\d{1,5}$/.test(retry || "") ? Math.min(60, Math.max(1, Number(retry))) : undefined);
          }
          throw new CoreError("UPSTREAM_FAILED");
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
        if (request.aborted) throw new CoreError("UPSTREAM_TIMEOUT");
        if (error instanceof CoreError) throw error;
        throw new CoreError("UPSTREAM_FAILED");
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
  return {
    origin, profileId: expected,
    async verify(signal) { await operation(signal).verify(); },
    async load(signal) {
      const op = operation(signal);
      try {
        await op.verify();
        const result = await getAllActiveCourseAssignments({ requestAll: op.requestAll });
        op.overall.throwIfAborted();
        return result;
      } catch (error) {
        if (op.overall.aborted) throw new CoreError("UPSTREAM_TIMEOUT");
        throw error;
      }
    },
  };
}
module.exports = { createCoreCanvas, canonicalId, configuredOrigin };

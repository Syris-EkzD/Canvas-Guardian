const http = require("node:http");
const { createHash, randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { selectActivities } = require("./activity-query");
const { CoreError } = require("./core-errors");
const { normalized, readCourses } = require("./core-course-service");

const TIMEZONE = "Asia/Manila";
const TTL = 60_000;
const MAX_RESPONSE = 1024 * 1024;
const views = new Set(["pending", "today", "week", "saved"]);
function queryFor(target, route) {
  const q = target.indexOf("?");
  const raw = q < 0 ? "" : target.slice(q + 1);
  if (route === "status" || route === "course") {
    if (q >= 0) throw new CoreError("INVALID_QUERY");
    return null;
  }
  const params = new Map();
  if (q >= 0) {
    for (const part of raw.split("&")) {
      const i = part.indexOf("=");
      if (i < 1) throw new CoreError("INVALID_QUERY");
      let key, value;
      try {
        key = decodeURIComponent(part.slice(0, i));
        value = decodeURIComponent(part.slice(i + 1));
      } catch { throw new CoreError("INVALID_QUERY"); }
      if (!(route === "assignments" ? ["limit", "offset", "revision"] : ["view", "limit", "offset", "revision"]).includes(key) || params.has(key))
        throw new CoreError("INVALID_QUERY");
      params.set(key, value);
    }
  }
  const view = params.get("view") ?? (route === "courses" ? "active" : "pending");
  const allowedViews = route === "courses" ? new Set(["active", "historical"]) : views;
  const maxOffset = route === "assignments" ? 100000 : 10000;
  const limit = params.get("limit") ?? "50";
  const offset = params.get("offset") ?? "0";
  const revision = params.get("revision");
  if (!allowedViews.has(view) || !/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100 ||
      !/^(0|[1-9]\d{0,5})$/.test(offset) || Number(offset) > maxOffset ||
      (revision !== undefined && !/^[a-f0-9]{64}$/.test(revision)) ||
      (Number(offset) > 0 && revision === undefined)) throw new CoreError("INVALID_QUERY");
  return { view, limit: Number(limit), offset: Number(offset), revision };
}
function createActivityService({ canvas, state, academic, accountId, now = Date.now, monotonic = () => performance.now() }) {
  let snapshot = null, inFlight = null, unverified = false;
  const lifetime = new AbortController();
  async function refresh() {
    if (unverified) throw new CoreError("ACCOUNT_UNVERIFIED");
    if (lifetime.signal.aborted) throw new CoreError("SERVICE_UNAVAILABLE");
    // Verify durable binding on cache hits as well as refreshes.
    const generation = academic?.capture();
    if (academic && snapshot && snapshot.generation !== generation) snapshot = null;
    if (snapshot && monotonic() - snapshot.tick >= 0 && monotonic() - snapshot.tick < TTL)
      return { snapshot, state: "cached" };
    if (!inFlight) {
      snapshot = null;
      const attemptedAt = new Date(now()).toISOString();
      inFlight = Promise.resolve().then(async () => {
        try {
          const candidate = academic ? await canvas.loadSnapshot(lifetime.signal) : await canvas.load(lifetime.signal);
          if (lifetime.signal.aborted) throw new CoreError("SERVICE_UNAVAILABLE");
          const fetchedAt = new Date(now()).toISOString();
          const tick = monotonic();
          const published = academic?.publish(generation, candidate, attemptedAt, fetchedAt);
          snapshot = { items: academic ? null : candidate, generation: published, tick, fetchedAt };
          return snapshot;
        } catch (error) {
          if (error instanceof CoreError && error.code === "ACCOUNT_UNVERIFIED") unverified = true;
          if (academic) {
            // If failure persistence fails, propagate that error and never
            // use old data. Shutdown and non-transient errors cannot serve stale.
            academic.recordFailure(generation, attemptedAt, error.code);
            if (error instanceof CoreError && error.allowStale === true && !lifetime.signal.aborted)
              error.staleGeneration = generation;
          }
          throw error;
        }
      }).finally(() => { inFlight = null; });
    }
    return { snapshot: await inFlight, state: "fresh" };
  }
  function activityDto({ view, limit, offset, revision }, result, items, overrides) {
    const evaluatedAt = new Date(now());
    const projected = selectActivities(items, key => overrides.get(key), view, evaluatedAt)
      .map(({ item, status }) => ({
        key: item.key, courseId: item.courseId, assignmentId: item.id,
        courseName: item.course, title: item.name, dueAt: item.dueAt ?? null,
        canvasUrl: item.htmlUrl ?? null, guardianStatus: status, submitted: false,
      }));
    const digest = createHash("sha256").update(JSON.stringify([accountId, view, projected])).digest("hex");
    if (revision !== undefined && digest !== revision) throw new CoreError("VIEW_CHANGED");
    const total = projected.length;
    return { accountId, view, timezone: TIMEZONE, evaluatedAt: evaluatedAt.toISOString(),
      freshness: { source: "canvas", fetchedAt: result.snapshot.fetchedAt,
        ageSeconds: Math.max(0, Math.floor((monotonic() - result.snapshot.tick) / 1000)),
        maxAgeSeconds: 60, state: result.state },
      page: { limit, offset, total, nextOffset: offset + limit < total ? offset + limit : null, revision: digest },
      items: projected.slice(offset, offset + limit) };
  }
  return {
    async activities(query) {
      const result = await refresh();
      if (!academic) return activityDto(query, result, result.snapshot.items, state.overrides());
      return academic.read({activities: true}, ({sync, assignments, overrides}) => {
        if (sync.generation !== result.snapshot.generation || sync.last_result !== "success")
          throw new CoreError("SNAPSHOT_UNAVAILABLE");
        return activityDto(query, result, assignments.map(normalized), overrides);
      });
    },
    async courses(route, courseId, query) {
      if (!academic) throw new CoreError("NOT_FOUND");
      let result;
      try {
        const fresh = await refresh();
        result = {generation: fresh.snapshot.generation, state: fresh.state};
      } catch (error) {
        if (!(error instanceof CoreError) || error.staleGeneration === undefined ||
            !error.staleGeneration || unverified || lifetime.signal.aborted) throw error;
        result = {generation: error.staleGeneration, state: "stale", error};
      }
      return readCourses({academic, accountId, result, route, courseId, query, now: now()});
    },
    status() {
      if (unverified) throw new CoreError("ACCOUNT_UNVERIFIED");
      return { accountId, timezone: TIMEZONE, ...state.status(), scheduleConfiguredMinutes: 10, runtimeHealth: "unverified" };
    },
    async stop() {
      lifetime.abort();
      if (inFlight) await inFlight.catch(() => {});
    },
  };
}

function createCoreApi({ authenticate, service, monotonic = () => performance.now(),
  globalLimit = 120, deviceLimit = 30, maxConnections = 64 }) {
  let windowStart = monotonic(), total = 0;
  const devices = new Map();
  function budget(device) {
    const tick = monotonic();
    if (tick - windowStart >= 60_000) { windowStart = tick; total = 0; devices.clear(); }
    const retry = Math.max(1, Math.ceil((60_000 - (tick - windowStart)) / 1000));
    if (!device) {
      if (++total > globalLimit) throw new CoreError("RATE_LIMITED", retry);
    } else {
      const count = (devices.get(device) || 0) + 1;
      if (count > deviceLimit || devices.size >= globalLimit && !devices.has(device)) throw new CoreError("RATE_LIMITED", retry);
      devices.set(device, count);
    }
  }
  function send(res, status, data, headers = {}) {
    const body = JSON.stringify(data);
    if (Buffer.byteLength(body) > MAX_RESPONSE) throw new CoreError("UPSTREAM_INVALID");
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Content-Length": Buffer.byteLength(body), Connection: "close", ...headers });
    res.end(body);
  }
  async function handle(req, res) {
    const requestId = randomUUID();
    try {
      budget();
      const authorization = req.headersDistinct.authorization;
      if (authorization?.length !== 1) throw new CoreError("UNAUTHENTICATED");
      const principal = authenticate(authorization[0]);
      budget(principal.deviceId);
      if (Object.values(req.headersDistinct).some(values => values.length > 1) ||
          req.headers["transfer-encoding"] !== undefined ||
          (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0") ||
          req.headers.expect !== undefined) throw new CoreError("INVALID_REQUEST");
      const target = req.url;
      if (!target || Buffer.byteLength(target) > 2048 || !target.startsWith("/") ||
          target.startsWith("//") || /[\x00-\x20\\#]/.test(target) || /%(?![0-9a-f]{2})/i.test(target))
        throw new CoreError("INVALID_REQUEST");
      const pathname = target.split("?")[0];
      let route, courseId;
      if (pathname === "/v1/status") route = "status";
      else if (pathname === "/v1/activities") route = "activities";
      else if (pathname === "/v1/courses") route = "courses";
      else {
        const match = /^\/v1\/courses\/([^/]+)(\/assignments)?$/.exec(pathname);
        if (!match) throw new CoreError("NOT_FOUND");
        if (!/^[1-9]\d{0,63}$/.test(match[1])) throw new CoreError("INVALID_REQUEST");
        courseId = match[1];
        route = match[2] ? "assignments" : "course";
      }
      if (req.method !== "GET") throw new CoreError("METHOD_NOT_ALLOWED");
      const query = queryFor(target, route);
      const data = route === "status" ? service.status()
        : route === "activities" ? await service.activities(query)
        : await service.courses(route, courseId, query);
      const latest = authenticate(authorization[0]);
      if (latest.deviceId !== principal.deviceId || latest.accountId !== principal.accountId)
        throw new CoreError("UNAUTHENTICATED");
      send(res, 200, data);
    } catch (error) {
      const safe = error instanceof CoreError ? error : new CoreError("INTERNAL_ERROR");
      const headers = {};
      if (safe.status === 401) headers["WWW-Authenticate"] = "Bearer";
      if (safe.status === 405) headers.Allow = "GET";
      if (safe.retryAfter) headers["Retry-After"] = String(safe.retryAfter);
      send(res, safe.status, { error: { code: safe.code, message: safe.message, requestId } }, headers);
    }
  }
  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 5000,
    requestTimeout: 10000, connectionsCheckingInterval: 1000, keepAliveTimeout: 1000 }, handle);
  server.maxConnections = maxConnections;
  server.maxRequestsPerSocket = 1;
  server.setTimeout(65_000, socket => socket.destroy());
  // Prevent Node's automatic 100 Continue from accepting a body.
  server.on("checkContinue", handle);
  server.on("checkExpectation", handle);
  server.on("upgrade", (req, socket) => socket.destroy());
  server.on("connect", (req, socket) => socket.destroy());
  return server;
}
module.exports = { createCoreApi, createActivityService };

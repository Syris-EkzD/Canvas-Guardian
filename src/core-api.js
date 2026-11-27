const http = require("node:http");
const { createHash, randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { selectActivities } = require("./activity-query");
const { CoreError } = require("./core-errors");

const TIMEZONE = "Asia/Manila";
const TTL = 60_000;
const MAX_RESPONSE = 1024 * 1024;
const views = new Set(["pending", "today", "week", "saved"]);
function queryFor(target, route) {
  const q = target.indexOf("?");
  const raw = q < 0 ? "" : target.slice(q + 1);
  if (route === "/v1/status") {
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
      if (!["view", "limit", "offset", "revision"].includes(key) || params.has(key))
        throw new CoreError("INVALID_QUERY");
      params.set(key, value);
    }
  }
  const view = params.get("view") ?? "pending";
  const limit = params.get("limit") ?? "50";
  const offset = params.get("offset") ?? "0";
  const revision = params.get("revision");
  if (!views.has(view) || !/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100 ||
      !/^(0|[1-9]\d{0,4})$/.test(offset) || Number(offset) > 10000 ||
      (revision !== undefined && !/^[a-f0-9]{64}$/.test(revision)) ||
      (Number(offset) > 0 && revision === undefined)) throw new CoreError("INVALID_QUERY");
  return { view, limit: Number(limit), offset: Number(offset), revision };
}
function createActivityService({ canvas, state, accountId, now = Date.now, monotonic = () => performance.now() }) {
  let snapshot = null, inFlight = null, unverified = false;
  const lifetime = new AbortController();
  async function refresh() {
    if (unverified) throw new CoreError("ACCOUNT_UNVERIFIED");
    if (snapshot && monotonic() - snapshot.tick < TTL) return { snapshot, state: "cached" };
    if (!inFlight) {
      snapshot = null;
      inFlight = Promise.resolve().then(() => canvas.load(lifetime.signal)).then(items => {
        snapshot = { items, tick: monotonic(), fetchedAt: new Date(now()).toISOString() };
        return snapshot;
      }).catch(error => {
        if (error instanceof CoreError && error.code === "ACCOUNT_UNVERIFIED") unverified = true;
        throw error;
      }).finally(() => { inFlight = null; });
    }
    return { snapshot: await inFlight, state: "fresh" };
  }
  return {
    async activities({ view, limit, offset, revision }) {
      const result = await refresh();
      const evaluatedAt = new Date(now());
      const overrides = state.overrides();
      const items = selectActivities(result.snapshot.items, key => overrides.get(key), view, evaluatedAt)
        .map(({ item, status }) => ({
          key: item.key, courseId: item.courseId, assignmentId: item.id,
          courseName: item.course, title: item.name, dueAt: item.dueAt ?? null,
          canvasUrl: item.htmlUrl ?? null, guardianStatus: status, submitted: false,
        }));
      const digest = createHash("sha256").update(JSON.stringify([accountId, view, items])).digest("hex");
      if (revision !== undefined && digest !== revision) throw new CoreError("VIEW_CHANGED");
      const total = items.length;
      return { accountId, view, timezone: TIMEZONE, evaluatedAt: evaluatedAt.toISOString(),
        freshness: { source: "canvas", fetchedAt: result.snapshot.fetchedAt,
          ageSeconds: Math.max(0, Math.floor((monotonic() - result.snapshot.tick) / 1000)),
          maxAgeSeconds: 60, state: result.state },
        page: { limit, offset, total, nextOffset: offset + limit < total ? offset + limit : null, revision: digest },
        items: items.slice(offset, offset + limit) };
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
      const route = target.split("?")[0];
      if (!["/v1/activities", "/v1/status"].includes(route)) throw new CoreError("NOT_FOUND");
      if (req.method !== "GET") throw new CoreError("METHOD_NOT_ALLOWED");
      const query = queryFor(target, route);
      const data = route === "/v1/status" ? service.status() : await service.activities(query);
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

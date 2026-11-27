# Guardian Core API v1 (CORE-1)

Optional, read-only backend process; no changes to the Telegram service, timers,
Canvas submission authority or SQLite schema. See approved contract in issue #25
and work package #26. Draft implementation is not deployment authorization.

## Local startup and provisioning

Node 24, npm ci. The process reads CANVAS_BASE_URL (HTTPS origin only),
CANVAS_ACCESS_TOKEN, GUARDIAN_CORE_REGISTRY (absolute path outside the repo),
and optional GUARDIAN_CORE_PORT (default 8787). Run npm run guardian:core-api
explicitly; it listens only on 127.0.0.1. No Telegram/Gemini/Calendar token needed.
Startup verifies Canvas self-profile before listening; a different profile or
origin is a different account and must not reuse legacy state. Stop with SIGTERM
or SIGINT. Stop the optional process to roll back; the legacy database is not
migrated, so do not restore an older backup over current data.

Trusted operator only: locally attest that the existing DB belongs to the
verified Canvas profile (the legacy DB cannot establish this). Use an absolute,
explicit existing state path. Create a restricted directory outside the repo
(0700 or 0750 with dedicated service group), registry mode 0600 or 0640; service
can read but must not write, operator owns registry and directory. Use a trusted
local editor or offline generator (not a web endpoint). Generate each device
credential with Node crypto.randomBytes(32).toString("base64url"), compute
crypto.createHash("sha256").update(token).digest("hex"), and record only the
digest. Transfer the plaintext once via a trusted channel and keep in OS
protected device storage. Never pass a token on command line, store in registry,
log, chat or commit it. Generate UUIDs with crypto.randomUUID(). Set absolute
expiry 30 days after issuance, UTC ISO timestamp with milliseconds.

Registry exact fields (placeholders below are illustrative, not usable values):

~~~json
{
  "version": 1,
  "ownerId": "<owner UUID>",
  "accountId": "<account UUID>",
  "canvasOrigin": "https://canvas.example.edu",
  "canvasProfileId": "99",
  "statePath": "/absolute/path/to/horus.db",
  "legacyOwnershipAttested": true,
  "devices": [
    {
      "deviceId": "<device UUID>",
      "tokenSha256": "<64 lowercase hex>",
      "scopes": ["academic:read"],
      "expiresAt": "<UTC ISO timestamp>",
      "revokedAt": null
    }
  ]
}
~~~

Write a new protected temporary file in the same restricted directory and
atomically rename it over the registry; never edit the live file in place.
Revoke by setting revokedAt to current UTC ISO timestamp, or remove the record.
Rotate with new device UUID and token, then revoke old. Registry is revalidated
per request and before successful response, with fixed-length digest comparisons.
Binding changes require restart and trusted ownership reassessment. Invalid
registry denies access. Never use a shared or human-chosen device password.
Registry max 128 KiB, 128 devices. No pairing/login/rotation HTTP endpoints.

Loopback cleartext is only for synthetic tests. Actual clients require a trusted
TLS reverse proxy over an approved private network/VPN, certificate validation,
no public exposure and no forwarding-based identity. Do not expose this process
directly or transmit real bearer over cleartext. Proxy/device provisioning,
production credentials, backup/restore and live provider acceptance are separate
owner-gated work. No TLS/device acceptance implied by tests.

## HTTP contract

All routes require Authorization: Bearer with a provisioned token and
academic:read scope. Server derives identity, never from caller fields.
JSON UTF-8, Cache-Control: no-store, no permissive CORS, cookies, or raw errors.

GET /v1/activities accepts view=pending|today|week|saved (default pending),
limit=1..100 (default 50), offset=0..10000 (default 0), and revision (64 lowercase
hex, required for nonzero offset). Unknown/duplicate params or body rejected.
Today uses Asia/Manila calendar date including overdue today; week is rolling
inclusive now through +7 days; pending includes overdue/undated; saved is
dismissed/completed_offline only, not Canvas submission. Submitted/unpublished/
excused work excluded. Due order ascending, undated last, ties source order.
Response fields: accountId, view, timezone, evaluatedAt (UTC ISO);
freshness {source, fetchedAt, ageSeconds, maxAgeSeconds, state};
page {limit, offset, total, nextOffset, revision};
items [{key, courseId, assignmentId, courseName, title, dueAt, canvasUrl,
guardianStatus, submitted}]. IDs strings, key courseId:assignmentId; nullable
dueAt and canvasUrl; URL limited to canonical same-origin HTTPS assignment path
with query/fragment stripped. No grades, rubric, provider secrets, or raw
submission data. Use revision on subsequent pages, restart at offset 0 on 409.
An out-of-range offset returns an empty page, not an empty view. No durable
pagination token.

GET /v1/status takes no query/body. Returns accountId, timezone, monitoring
(running/paused/stopped), calendarSyncEnabled, scheduleConfiguredMinutes (10,
template configuration), runtimeHealth (unverified). No claim about live
pollers. Reads only legacy app_settings. Missing tables in a valid attested
uninitialized SQLite file use existing defaults; missing DB, malformed schema,
bad values, inaccessible or locked state fails closed. Legacy state queried
read-only; no implicit create, lazy DDL or durable writes.

Canvas complete active course + assignment pages, verified self-profile each
refresh, GET only, same origin/path pagination and no redirects. Snapshot
published only on complete success, memory only, coalesced refresh; TTL 60s
monotonic, fetchedAt completion, fresh if awaited refresh, cached if prior valid
snapshot. No stale 200 after refresh failure, no partial list; a successful
empty complete view is distinct. Client may display previously cached result
explicitly stale, not infer zero from failure. A detected account mismatch
blocks until restart/re-attestation. Local override snapshot evaluated afresh.
Independent Telegram/API caches may differ by fetch time.

Errors use {"error":{"code":"...","message":"...","requestId":"..."}}.
400 INVALID_QUERY/INVALID_REQUEST; 401 UNAUTHENTICATED with WWW-Authenticate;
403 FORBIDDEN; 404 NOT_FOUND; 405 METHOD_NOT_ALLOWED with Allow: GET;
409 VIEW_CHANGED; 429 RATE_LIMITED with Retry-After; 502 UPSTREAM_INVALID or
UPSTREAM_FAILED (including upstream auth failure); 503 SERVICE_UNAVAILABLE or
ACCOUNT_UNVERIFIED (upstream throttling may include Retry-After); 504
UPSTREAM_TIMEOUT; 500 INTERNAL_ERROR. Parser/proxy 408/431 may occur before
application JSON. No request/response body, Authorization, query or title logs.
Startup errors generic. No retries or writes.

Bounds: 10,000 assignment rows (and course rows), 1,000 upstream requests
including profile, 60s total refresh, 15s per request, 2 MiB upstream body/page,
64 MiB aggregate upstream bytes, 1 MiB API page, 2048-byte request target,
8 KiB headers, 5s header and 10s request receipt timeout, 65s socket idle
timeout, 64 connections, one request per connection, fixed 60s windows of 30
authorized requests/device and 120 global including invalid requests. These
are conservative engineering limits, not capacity measurements; over-limit
snapshots fail closed. Proxy ingress limits remain an operational gate.

## Verification and integration

Run existing focused activity/status/Canvas/Telegram/import tests, new
activity-query/core-canvas/core-api tests, npm test, npm audit --omit=dev
--audit-level=high. All fixtures synthetic; no actual credentials or live
submissions. Existing main and candidate SQLite state must remain intact.
PR #16 remains independent: after its separately authorized acceptance/merge,
reconcile CORE-1 and run full combined tests plus #16 focused AI suite,
adapter 60-item cap/shape, exact-payload authorization and polling safeguards.
If #16 stays paused, no CORE-1 merge without revised owner-approved plan.

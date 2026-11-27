# CORE-2A — persistent academic reads (HTTP v1)

Draft implementation for #30, stacked on CORE-1 #27 at
729c0b849507fcd1a38e1fa4cb7605317d674035. Not authorized for production
migration, deployment or activation. This document supplements
docs/core-api-v1.md. The v1 activities/status DTOs and the academic:read scope
remain unchanged. No Canvas writes, archive routes, archive permission,
monitor/Calendar/AI changes or new dependencies.

## Explicit migration and binding

The Core API in this candidate requires Guardian-owned schema version 1 before
startup. It never creates a database or runs DDL on import or request.
The trusted registry still uses version 1; ownerId/accountId UUIDs,
canonical HTTPS origin, exact string profile ID and attested statePath
must match the durable singleton binding. A detected binding mismatch is
latched until restart/re-attestation. The real entrypoint requires the
canonical existing data/horus.db used by legacy consumers, not a second
database or a symlink. Tests inject a separate expected path under a temporary
restricted directory. Registry and backup remain outside the repository in
protected directories; the state directory must not be accessible to others
or group writable. No credentials are stored in academic tables.

For a future separately authorized cutover only:

1. Resolve #17/#18 and coordinated #16/#27/2A/2B compatibility and recovery
   gates. Stop bot, API, timers, manual jobs and all writers; verify no
   competing process. Do not use old and new processes together. Verify
   ownership, state path, profile, registry and protected filesystem.
2. The explicit local command is:
   npm run guardian:core-migrate -- /absolute/restricted/backup-before-core.db
   with GUARDIAN_CORE_REGISTRY, CANVAS_BASE_URL and CANVAS_ACCESS_TOKEN
   in the trusted local environment, never as command-line token arguments.
   The command verifies the self-profile using the strict GET loader,
   validates known legacy table definitions and integrity/FKs, reserves a
   new mode-0600 backup path (never overwrites), uses SQLite's consistent
   backup API including committed WAL pages, verifies the backup and rejects
   data_version drift before transactional additive migration.
3. The migration adds guardian_schema_migrations, guardian_account,
   guardian_sync, guardian_courses, guardian_assignments and an assignment
   ordering index in a single BEGIN IMMEDIATE transaction. It leaves
   PRAGMA user_version and all legacy tables/rows/indexes/settings, offsets,
   baseline markers, Calendar mappings, sqlite_sequence and AI evidence
   untouched. An older ai_submissions without destination_json is supported.
   No approval cancellation, identity transfer or legacy dedup rewrite.
   Unknown Guardian schema/version, malformed known legacy schema, missing,
   locked or unsafe file, profile/binding mismatch or transaction failure
   fails closed. Repeating with the same verified binding is a no-op.
4. Independently verify the backup on a separate isolated restored copy:
   compare schema and logical rows, integrity_check and foreign_key_check,
   including legacy markers/offsets and unresolved AI evidence. Never
   replace the production database as a test. The synthetic suite tests
   the copy procedure; real recovery readiness remains a separate gate.

If migration fails, the DDL/binding/marker transaction rolls back; keep the
backup for offline inspection. A failed backup is not a verified restore
point. Use a new path for retry. If migration succeeds and no subsequent
writes/effects have happened, a coordinated stop and verified restoration of
the pre-migration DB with matching code/config is the future rollback option.
After any new writes or effects, do not blindly restore an old backup
(offsets, approvals and event markers could be lost); stop, preserve current
state and reconcile with the owner. No automatic down migration or table
drops. Mixed-version operation and archive activation are prohibited.
CORE-2B/integration must enforce the policy at every participating consumer;
2A never claims those guarantees.

## Publication

The sole publisher is the Core API's coalesced on-demand strict refresh;
no new scheduler. One verified complete roster and all assignment pages
(including zero-work courses) are fetched with the existing GET-only
origin/path, redirect, profile, ID, pagination, timeout, row and byte limits.
No DB transaction spans network I/O. The generation captured before I/O is
compared again in a BEGIN IMMEDIATE publication transaction, which upserts
normalized metadata, marks authoritative absences, records the success and
increments the generation atomically. Failure leaves the previous generation
and last success intact and records a bounded safe failure when the DB is
writable. Concurrent late publication cannot overwrite a newer generation.
Retain the last known row per identity, not an event log; course absence
does not prove assignment deletion. The caps are 10k retained courses and
100k retained assignments, explicit failure and no eviction. No raw provider
bodies, grades, materials, rubrics or submission eligibility. Only active
local archive state is created; unexpected non-active state is rejected.

A 60s monotonic in-process TTL is used for strict CORE-1 reads; restart
forces a refresh even with durable history. No stale activity success.
New course reads may serve explicitly stale last-complete metadata after
transient network/timeouts, upstream 5xx or throttling, if binding remains
verified; no stale fallback on upstream authorization failure, invalid
response, account mismatch, DB/registry failure, shutdown or first failed
refresh. Backward wall clock is stale for historical freshness. Stale
metadata never implies live enrollment, submission permission or eligibility.
One API publisher process only; no multi-process deployment claim.

## HTTP reads

Existing bearer authentication, final reauthorization, HTTP limits, safe
errors and no body apply. Only GET is implemented; unescaped canonical positive
decimal string IDs up to 64 digits. No client-supplied account ID. New reads:

- GET /v1/courses?view=active|historical&limit=50&offset=0[&revision=64hex].
  Default active. Active is locally active and present in the last complete
  roster; historical is absent upstream (local archive is not activated).
  Lexical course ID order. Envelope: accountId, timezone, evaluatedAt, sync,
  page, items. Item: courseId, courseName, archiveState, archivedAt,
  stateVersion, upstreamPresence, lastSeenAt, assignmentFetchedAt.
- GET /v1/courses/:courseId, no query. Same account/time/sync envelope with
  course (same DTO). Known historical course and zero-work course accessible.
- GET /v1/courses/:courseId/assignments?limit=50&offset=0[&revision=64hex].
  Same account/time/sync/page/items envelope plus courseId and freshness
  {fetchedAt,state}. Item: key, courseId, assignmentId, title, dueAt,
  canvasUrl, published, submitted, excused, guardianStatus, presence,
  lastSeenAt. Active courses show current present published assignments
  including submitted and excused; historical courses show retained published
  rows including absent assignments. Unpublished rows are persisted as
  minimal normalized metadata but conservatively excluded from both new read
  views. Status is last-known Canvas plus current legacy override, not
  eligibility. Due ascending, undated last, ties by most recent generation,
  source order, then ID. No grades/raw content.
- sync: {lastSuccessAt,lastAttemptAt,state,lastResult,errorCode}; state is
  fresh/cached/stale/never; lastResult never/success/failed. No success response
  without a complete generation. Assignment freshness is fresh/cached/stale/
  never; frozen is reserved for future archived state. A missing course under
  stale roster is not a reliable 404: return the current upstream error or
  503 SNAPSHOT_UNAVAILABLE. Under a complete authoritative roster, unknown
  course is 404; retained known historical course is accessible.

Page fields limit, offset, total, nextOffset, revision. Limit 1..100,
default 50; revision lowercase 64hex required when offset >0, digest includes
account/view and ordered projected items (course assignments also include
course identity/state/version/presence); 409 VIEW_CHANGED on mismatch.
CORE-1 activities and course list keep offset 0..10000. Candidate course
assignment history allows offset 0..100000 to make all retained rows
pageable within the approved 100k cap; this clarification and conservative
unpublished exclusion are explicitly flagged for coordinator review.
No new scope or archive mutation; PUT/DELETE archive routes absent.
No changes to existing Telegram, Calendar, AI or status override ownership.

## Verification and remaining integration

Use only isolated synthetic temporary SQLite files and mocked Canvas GET.
Focused: node --test test/core-api.test.js test/core-canvas.test.js
test/activity-query.test.js test/runtime-import-safety.test.js.
Full: npm test. Audit: npm audit --omit=dev --audit-level=high.
Existing CORE-1 loopback fixture tests explicitly migrate synthetic DBs before
startup and compare the legacy logical schema/rows rather than assuming no
Guardian-owned writes. Independent review must verify exact candidate CI
checkout, migration backup/restore, failed publication, auth and all API
contracts. A green isolated stacked CI does not establish combined #16
acceptance or production readiness. #19 existing advisories remain separate.

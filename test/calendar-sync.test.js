const { test } = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

const {
  buildGoogleEvent,
  createContentHash,
  ensureCalendarTable,
  syncCalendarAssignments,
} = require("../src/calendar-sync");

const calendarId = "fake-calendar-id";
const now = Date.parse("2042-03-01T00:00:00.000Z");

function assignment(overrides = {}) {
  return {
    id: "101",
    key: "10:101",
    courseId: "10",
    course: "TEST-10",
    name: "Example assignment",
    dueAt: "2042-03-10T08:00:00.000Z",
    htmlUrl: "https://canvas.example.edu/courses/10/assignments/101",
    published: true,
    submitted: false,
    excused: false,
    ...overrides,
  };
}

function createDb() {
  const db = new Database(":memory:");
  ensureCalendarTable(db);
  return db;
}

function saveMapping(
  db,
  {
    key = "10:101",
    eventId = "mapped-event",
    dueAt = "2042-03-10T08:00:00.000Z",
    contentHash = "old-content",
  } = {}
) {
  db.prepare(`
    INSERT INTO google_calendar_events (
      assignment_key,
      google_event_id,
      due_at,
      content_hash,
      synced_at
    )
    VALUES (?, ?, ?, ?, ?)
  `).run(
    key,
    eventId,
    dueAt,
    contentHash,
    "2042-02-28T00:00:00.000Z"
  );
}

function getMapping(db, key = "10:101") {
  return db.prepare(`
    SELECT assignment_key, google_event_id, due_at, content_hash
    FROM google_calendar_events
    WHERE assignment_key = ?
  `).get(key);
}

function googleError(status) {
  const error = new Error(`Google error ${status}`);
  error.response = { status };
  return error;
}

function managedRemoteEvent(activity, id) {
  return {
    id,
    extendedProperties: {
      private: {
        managedBy: "horus",
        canvasAssignmentKey: activity.key,
      },
    },
  };
}

function createFakeCalendar({
  remoteEvents = [],
  deleteStatuses = {},
  updateStatuses = {},
  insertIds = [],
} = {}) {
  const remote = remoteEvents.map((event) => ({
    ...event,
    extendedProperties: event.extendedProperties
      ? JSON.parse(JSON.stringify(event.extendedProperties))
      : undefined,
  }));
  const queuedInsertIds = [...insertIds];
  const calls = {
    list: [],
    delete: [],
    update: [],
    insert: [],
  };

  const calendar = {
    events: {
      async list(parameters) {
        calls.list.push(parameters);

        const keyFilter = parameters.privateExtendedProperty?.find(
          (value) => value.startsWith("canvasAssignmentKey=")
        );
        const key = keyFilter?.slice("canvasAssignmentKey=".length);

        const items = remote.filter((event) => {
          const properties = event.extendedProperties?.private;

          return (
            properties?.managedBy === "horus" &&
            properties?.canvasAssignmentKey === key
          );
        });

        return { data: { items } };
      },

      async delete(parameters) {
        calls.delete.push(parameters);

        const status = deleteStatuses[parameters.eventId];

        if (status) {
          throw googleError(status);
        }

        const index = remote.findIndex(
          (event) => event.id === parameters.eventId
        );

        if (index >= 0) {
          remote.splice(index, 1);
        }

        return { data: {} };
      },

      async update(parameters) {
        calls.update.push(parameters);

        const status = updateStatuses[parameters.eventId];

        if (status) {
          throw googleError(status);
        }

        const index = remote.findIndex(
          (event) => event.id === parameters.eventId
        );

        if (index >= 0) {
          remote[index] = {
            id: parameters.eventId,
            ...parameters.requestBody,
          };
        }

        return { data: { id: parameters.eventId } };
      },

      async insert(parameters) {
        calls.insert.push(parameters);

        const id =
          queuedInsertIds.length > 0
            ? queuedInsertIds.shift()
            : `inserted-${calls.insert.length}`;

        if (!id) {
          return { data: {} };
        }

        remote.push({
          id,
          ...parameters.requestBody,
        });

        return { data: { id } };
      },
    },
  };

  return { calendar, calls, remote };
}

async function sync({ db, assignments, fake }) {
  return syncCalendarAssignments({
    assignments,
    calendar: fake.calendar,
    calendarId,
    db,
    now,
    log: () => {},
  });
}

for (const scenario of [
  {
    name: "loses its due date",
    assignments: [assignment({ dueAt: null })],
  },
  {
    name: "becomes unpublished",
    assignments: [assignment({ published: false })],
  },
  {
    name: "disappears from the complete Canvas snapshot",
    assignments: [],
  },
  {
    name: "becomes submitted",
    assignments: [assignment({ submitted: true })],
  },
]) {
  test(`removes a mapped event when an assignment ${scenario.name}`, async () => {
    const db = createDb();
    saveMapping(db);
    const fake = createFakeCalendar();

    const result = await sync({
      db,
      assignments: scenario.assignments,
      fake,
    });

    assert.equal(fake.calls.delete.length, 1);
    assert.equal(fake.calls.delete[0].eventId, "mapped-event");
    assert.equal(getMapping(db), undefined);
    assert.equal(result.removed, 1);
    db.close();
  });
}

for (const status of [404, 410]) {
  test(`removes the local mapping when remote deletion reports ${status}`, async () => {
    const db = createDb();
    saveMapping(db);
    const fake = createFakeCalendar({
      deleteStatuses: { "mapped-event": status },
    });

    await sync({ db, assignments: [], fake });

    assert.equal(getMapping(db), undefined);
    db.close();
  });
}

test("retains the mapping and propagates unexpected remote deletion failures", async () => {
  const db = createDb();
  saveMapping(db);
  const fake = createFakeCalendar({
    deleteStatuses: { "mapped-event": 500 },
  });

  await assert.rejects(
    sync({ db, assignments: [], fake }),
    /Google error 500/
  );

  assert.equal(getMapping(db).google_event_id, "mapped-event");
  db.close();
});

for (const status of [404, 410]) {
  test(`recovers a changed mapped event when update reports ${status}`, async () => {
    const db = createDb();
    saveMapping(db, { contentHash: "stale-content" });
    const current = assignment({ name: `Changed after ${status}` });
    const replacementId = `replacement-${status}`;
    const fake = createFakeCalendar({
      updateStatuses: { "mapped-event": status },
      insertIds: [replacementId],
    });

    const result = await sync({
      db,
      assignments: [current],
      fake,
    });

    assert.equal(fake.calls.update[0].eventId, "mapped-event");
    assert.equal(fake.calls.insert.length, 1);
    assert.equal(getMapping(db).google_event_id, replacementId);
    assert.equal(result.created, 1);
    db.close();
  });
}

test("does not save a replacement mapping when Google returns no recreated event ID", async () => {
  const db = createDb();
  saveMapping(db, { contentHash: "stale-content" });
  const fake = createFakeCalendar({
    updateStatuses: { "mapped-event": 404 },
    insertIds: [null],
  });

  await assert.rejects(
    sync({ db, assignments: [assignment({ name: "No ID" })], fake }),
    /Google did not return an event ID/
  );

  assert.equal(getMapping(db).google_event_id, "mapped-event");
  db.close();
});

test("recovers a previously created managed event instead of inserting a duplicate", async () => {
  const db = createDb();
  const current = assignment();
  const fake = createFakeCalendar({
    remoteEvents: [
      managedRemoteEvent(current, "orphan-from-lost-response"),
    ],
  });

  const result = await sync({
    db,
    assignments: [current],
    fake,
  });

  assert.equal(fake.calls.list.length, 1);
  assert.equal(fake.calls.update.length, 1);
  assert.equal(
    fake.calls.update[0].eventId,
    "orphan-from-lost-response"
  );
  assert.equal(fake.calls.insert.length, 0);
  assert.equal(
    getMapping(db).google_event_id,
    "orphan-from-lost-response"
  );
  assert.equal(result.recovered, 1);
  db.close();
});

test("fails conservatively when multiple managed recovery candidates exist", async () => {
  const db = createDb();
  const current = assignment();
  const fake = createFakeCalendar({
    remoteEvents: [
      managedRemoteEvent(current, "duplicate-one"),
      managedRemoteEvent(current, "duplicate-two"),
    ],
  });

  await assert.rejects(
    sync({ db, assignments: [current], fake }),
    /Multiple managed Google Calendar events found/
  );

  assert.equal(fake.calls.insert.length, 0);
  assert.equal(getMapping(db), undefined);
  db.close();
});

test("does not update or insert an unchanged mapped event", async () => {
  const db = createDb();
  const current = assignment();
  const event = buildGoogleEvent(current);

  saveMapping(db, {
    dueAt: current.dueAt,
    contentHash: createContentHash(event),
  });

  const fake = createFakeCalendar();
  const result = await sync({
    db,
    assignments: [current],
    fake,
  });

  assert.equal(fake.calls.update.length, 0);
  assert.equal(fake.calls.insert.length, 0);
  assert.equal(fake.calls.list.length, 0);
  assert.equal(result.unchanged, 1);
  db.close();
});

test("updates a changed mapped event and refreshes its hash", async () => {
  const db = createDb();
  const current = assignment({ name: "Changed assignment" });

  saveMapping(db, {
    dueAt: current.dueAt,
    contentHash: "stale-content",
  });

  const fake = createFakeCalendar();
  const result = await sync({
    db,
    assignments: [current],
    fake,
  });

  assert.equal(fake.calls.update.length, 1);
  assert.equal(fake.calls.insert.length, 0);
  assert.equal(
    getMapping(db).content_hash,
    createContentHash(buildGoogleEvent(current))
  );
  assert.equal(result.updated, 1);
  db.close();
});

test("keeps skipping a new unmapped assignment whose due date is already past", async () => {
  const db = createDb();
  const current = assignment({
    dueAt: "2042-02-28T08:00:00.000Z",
  });
  const fake = createFakeCalendar();

  const result = await sync({
    db,
    assignments: [current],
    fake,
  });

  assert.equal(fake.calls.list.length, 1);
  assert.equal(fake.calls.insert.length, 0);
  assert.equal(getMapping(db), undefined);
  assert.equal(result.pastSkipped, 1);
  db.close();
});

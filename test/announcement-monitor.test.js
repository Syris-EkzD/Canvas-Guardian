const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  getAnnouncementsWith,
} = require("../src/announcement-monitor");

test("returns no announcements without requesting the endpoint when there are no active courses", async () => {
  const requestedPaths = [];

  const result = await getAnnouncementsWith(async (path) => {
    requestedPaths.push(path);

    if (
      path ===
      "/api/v1/courses?enrollment_state=active&per_page=100"
    ) {
      return [];
    }

    throw new Error(`Unexpected Canvas request: ${path}`);
  });

  assert.deepEqual(result, []);
  assert.deepEqual(requestedPaths, [
    "/api/v1/courses?enrollment_state=active&per_page=100",
  ]);
});

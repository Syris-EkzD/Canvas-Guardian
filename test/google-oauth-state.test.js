const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createOAuthState, matchesOAuthState } = require("../src/google-oauth-state");

test("OAuth callback state must match the current authorization attempt", () => {
  const state = createOAuthState();
  assert.match(state, /^[a-f0-9]{64}$/);
  assert.notEqual(state, createOAuthState());
  assert.equal(matchesOAuthState(state, state), true);
  assert.equal(matchesOAuthState(state, null), false);
  assert.equal(matchesOAuthState(state, createOAuthState()), false);
  assert.equal(matchesOAuthState(state, state.slice(1)), false);
});

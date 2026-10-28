const { randomBytes, timingSafeEqual } = require("node:crypto");

function createOAuthState() {
  return randomBytes(32).toString("hex");
}

function matchesOAuthState(expected, received) {
  if (typeof received !== "string" || received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

module.exports = { createOAuthState, matchesOAuthState };

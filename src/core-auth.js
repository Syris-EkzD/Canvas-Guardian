const fs = require("node:fs");
const path = require("node:path");
const { createHash, timingSafeEqual } = require("node:crypto");
const { CoreError } = require("./core-errors");
const { canonicalId, configuredOrigin } = require("./core-canvas");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_REGISTRY_BYTES = 128 * 1024;
const unavailable = () => { throw new CoreError("SERVICE_UNAVAILABLE"); };

function iso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}
function fields(value, names) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key));
}
function readRegistry(file) {
  try {
    if (!path.isAbsolute(file)) unavailable();
    const parent = path.dirname(file);
    if (fs.realpathSync(parent) !== parent || (fs.statSync(parent).mode & 0o027) !== 0) unavailable();
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let data;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || ![0o600, 0o640].includes(stat.mode & 0o777) ||
          stat.size > MAX_REGISTRY_BYTES || stat.size < 2) unavailable();
      const buffer = Buffer.alloc(MAX_REGISTRY_BYTES + 1);
      let read = 0;
      while (read < buffer.length) {
        const n = fs.readSync(fd, buffer, read, buffer.length - read, null);
        if (!n) break;
        read += n;
      }
      if (read > MAX_REGISTRY_BYTES || read !== stat.size) unavailable();
      data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, read)));
    } finally { fs.closeSync(fd); }
    if (!fields(data, ["version", "ownerId", "accountId", "canvasOrigin", "canvasProfileId",
      "statePath", "legacyOwnershipAttested", "devices"]) ||
      data.version !== 1 || !UUID.test(data.ownerId) || !UUID.test(data.accountId) ||
      typeof data.ownerId !== "string" || typeof data.accountId !== "string" ||
      data.legacyOwnershipAttested !== true || typeof data.statePath !== "string" ||
      !path.isAbsolute(data.statePath) || path.normalize(data.statePath) !== data.statePath ||
      configuredOrigin(data.canvasOrigin) !== data.canvasOrigin ||
      canonicalId(data.canvasProfileId) !== data.canvasProfileId ||
      !Array.isArray(data.devices) || data.devices.length > 128) unavailable();
    const ids = new Set(), hashes = new Set();
    for (const device of data.devices) {
      if (!fields(device, ["deviceId", "tokenSha256", "scopes", "expiresAt", "revokedAt"]) ||
          typeof device.deviceId !== "string" || !UUID.test(device.deviceId) ||
          typeof device.tokenSha256 !== "string" || !HEX.test(device.tokenSha256) ||
          ids.has(device.deviceId) || hashes.has(device.tokenSha256) ||
          !Array.isArray(device.scopes) || device.scopes.length > 1 ||
          device.scopes.some(scope => scope !== "academic:read") ||
          !iso(device.expiresAt) || !(device.revokedAt === null || iso(device.revokedAt))) unavailable();
      ids.add(device.deviceId); hashes.add(device.tokenSha256);
    }
    return data;
  } catch { unavailable(); }
}
function bindingOf(registry) {
  const { ownerId, accountId, canvasOrigin, canvasProfileId, statePath, legacyOwnershipAttested } = registry;
  return { ownerId, accountId, canvasOrigin, canvasProfileId, statePath, legacyOwnershipAttested };
}
function createCoreAuth(file, binding, now = Date.now) {
  return function authenticate(header) {
    if (typeof header !== "string" || !header.startsWith("Bearer ") || !TOKEN.test(header.slice(7)))
      throw new CoreError("UNAUTHENTICATED");
    const registry = readRegistry(file);
    if (JSON.stringify(bindingOf(registry)) !== JSON.stringify(binding))
      throw new CoreError("ACCOUNT_UNVERIFIED");
    const digest = createHash("sha256").update(header.slice(7)).digest();
    let match;
    // Do not stop on the first comparison; digests are fixed-length.
    for (const device of registry.devices) {
      if (timingSafeEqual(digest, Buffer.from(device.tokenSha256, "hex"))) match = device;
    }
    if (!match || match.revokedAt !== null || now() >= Date.parse(match.expiresAt))
      throw new CoreError("UNAUTHENTICATED");
    if (!match.scopes.includes("academic:read")) throw new CoreError("FORBIDDEN");
    return { deviceId: match.deviceId, accountId: binding.accountId };
  };
}
module.exports = { readRegistry, bindingOf, createCoreAuth };

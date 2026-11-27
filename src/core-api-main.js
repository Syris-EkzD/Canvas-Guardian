const path = require("node:path");
const { readRegistry, bindingOf, createCoreAuth } = require("./core-auth");
const { createReadState } = require("./core-read-state");
const { createCoreCanvas, configuredOrigin } = require("./core-canvas");
const { createCoreApi, createActivityService } = require("./core-api");
const { CoreError } = require("./core-errors");

async function startCoreApi({ env = process.env, fetchImpl = global.fetch, now = Date.now,
  monotonic, port = 8787 } = {}) {
  const file = env.GUARDIAN_CORE_REGISTRY;
  if (!file || !path.isAbsolute(file) ||
      path.relative(path.resolve(__dirname, ".."), file).split(path.sep)[0] !== "..")
    throw new CoreError("SERVICE_UNAVAILABLE");
  const binding = bindingOf(readRegistry(file));
  if (configuredOrigin(env.CANVAS_BASE_URL) !== binding.canvasOrigin)
    throw new CoreError("ACCOUNT_UNVERIFIED");
  const canvas = createCoreCanvas({ baseUrl: binding.canvasOrigin,
    token: env.CANVAS_ACCESS_TOKEN, profileId: binding.canvasProfileId, fetchImpl });
  await canvas.verify();
  const authenticate = createCoreAuth(file, binding, now);
  const state = createReadState(binding.statePath);
  const service = createActivityService({ canvas, state, accountId: binding.accountId, now, monotonic });
  const server = createCoreApi({ authenticate, service, monotonic });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return { server, async stop() {
    const stopped = service.stop();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await stopped;
  } };
}
if (require.main === module) {
  require("dotenv").config({ quiet: true });
  const raw = process.env.GUARDIAN_CORE_PORT ?? "8787";
  if (!/^[1-9]\d{0,4}$/.test(raw) || Number(raw) > 65535) {
    console.error("Guardian Core API startup failed.");
    process.exitCode = 1;
  } else {
    startCoreApi({ port: Number(raw) }).then(runtime => {
      console.log("Guardian Core API listening on loopback.");
      const stop = () => { void runtime.stop().catch(() => { process.exitCode = 1; }); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }).catch(() => {
      console.error("Guardian Core API startup failed.");
      process.exitCode = 1;
    });
  }
}
module.exports = { startCoreApi };

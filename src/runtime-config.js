function requireEnvironment(names, env = process.env) {
  const missing = names.filter((name) => !env[name]);

  if (missing.length > 0) {
    const label = missing.length === 1
      ? "environment variable"
      : "environment variables";
    throw new Error(`Missing required ${label}: ${missing.join(", ")}`);
  }

  return Object.fromEntries(names.map((name) => [name, env[name]]));
}

module.exports = { requireEnvironment };

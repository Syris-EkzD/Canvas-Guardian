const { createGeminiProvider } = require("./gemini-provider");

const DEFAULT_MODEL = "gemini-3.8-flash";

function selectedModel(model) {
  return model ?? process.env.AI_MODEL ?? process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
}

function resolveProvider({ provider, client, apiKey } = {}) {
  if (provider) {
    if (typeof provider.chat !== "function" || typeof provider.draft !== "function") {
      throw new Error("AI provider must implement chat and draft");
    }
    return provider;
  }
  const selection = (process.env.AI_PROVIDER || "gemini").toLowerCase();
  if (selection !== "gemini") throw new Error("Unsupported AI_PROVIDER: " + selection);
  const key = apiKey ?? process.env.GEMINI_API_KEY;
  if (!client && !key) return null;
  return createGeminiProvider({ client, apiKey: key });
}

module.exports = { resolveProvider, selectedModel };

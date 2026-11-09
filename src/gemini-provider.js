const { GoogleGenAI, ThinkingLevel } = require("@google/genai");

function createGeminiProvider({ client, apiKey } = {}) {
  const sdk = client || new GoogleGenAI({ apiKey });

  function contentsFor(messages) {
    return messages.map((message) => {
      if (message.role === "user" || message.role === "assistant" && typeof message.text === "string") {
        return { role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.text }] };
      }
      if (message.role === "assistant" && Array.isArray(message.toolCalls)) {
        return { role: "model", parts: message.toolCalls.map(({ name, args, id }) => ({
          functionCall: { name, args, ...(id ? { id } : {}) },
        })) };
      }
      if (message.role === "tool" && Array.isArray(message.toolResults)) {
        return { role: "user", parts: message.toolResults.map(({ name, result, id }) => ({
          functionResponse: { name, response: { result }, ...(id ? { id } : {}) },
        })) };
      }
      throw new Error("Invalid provider conversation message");
    });
  }

  function complete(response) {
    if (response?.candidates?.[0]?.finishReason !== "STOP") {
      const error = new Error("Provider did not return a complete response");
      error.code = "invalid_response";
      throw error;
    }
    return response;
  }

  return {
    async chat({ model, system, messages, tools }) {
      const response = complete(await sdk.models.generateContent({
        model,
        contents: contentsFor(messages),
        config: {
          systemInstruction: system,
          tools: [{ functionDeclarations: tools }],
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          maxOutputTokens: 2500,
          automaticContinuation: false,
          httpOptions: { timeout: 45000 },
        },
      }));
      const calls = response.functionCalls ||
        response.candidates[0].content?.parts?.filter(part => part.functionCall).map(part => part.functionCall) || [];
      if (calls.length) {
        return { toolCalls: calls.map(({ name, args, id }) => ({ name, args, ...(id ? { id } : {}) })) };
      }
      return { text: response.text };
    },
    async draft({ model, system, contents, timeoutMs, signal }) {
      const response = complete(await sdk.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: system,
          responseMimeType: "application/json",
          maxOutputTokens: 4096,
          automaticContinuation: false,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          abortSignal: signal,
          httpOptions: { timeout: timeoutMs },
        },
      }));
      return { text: response.text };
    },
  };
}

module.exports = { createGeminiProvider };

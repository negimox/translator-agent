import { test } from "node:test";
import assert from "node:assert/strict";
import { TranslatorAgent } from "../src/agent/TranslatorAgent";
import type { AgentConfig } from "../src/config";

function agentWith(overrides: Partial<AgentConfig>): TranslatorAgent {
  const config = {
    jitsiDomain: "meet.example.com",
    roomName: "room",
    targetLanguage: "en",
    displayNamePrefix: "translator-",
    elevenLabsApiKey: "",
    ...overrides,
  } as unknown as AgentConfig;
  return new TranslatorAgent(config);
}

test("a config-class pipeline failure aborts agent startup", async () => {
  const agent = agentWith({ elevenLabsApiKey: "" });
  await assert.rejects(
    (agent as any).initializeTranslationPipeline(),
    /Translation pipeline unavailable: .*ELEVENLABS_API_KEY/,
  );
  assert.equal(agent.getTranslationPipeline(), null);
});

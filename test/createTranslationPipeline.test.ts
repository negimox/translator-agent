import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentConfig } from "../src/config";
import { createTranslationPipeline } from "../src/agent/createTranslationPipeline";
import { makeFakeFactory } from "./helpers/fakes";

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    elevenLabsApiKey: "k",
    mizanUsername: "",
    mizanPassword: "",
    sourceLanguage: "",
    targetLanguage: "en",
    translationTemplatePattern: "translator_{target}",
    ttsSpeed: 1,
    tokenBucketCapacity: 8,
    tokenBucketRefillRate: 8,
    circuitBreakerErrorThreshold: 0.1,
    circuitBreakerWindowMs: 60000,
    circuitBreakerOpenTimeoutMs: 10000,
    maxQueueLength: 12,
    retryInitialDelayMs: 500,
    retryMaxDelayMs: 8000,
    maxRetries: 3,
    ...overrides,
  } as unknown as AgentConfig;
}

test("DeepL-only config builds a pipeline without Mizan credentials", () => {
  const { factory } = makeFakeFactory();
  const result = createTranslationPipeline(agentConfig(), () => factory);
  assert.ok("pipeline" in result);
});

test("missing ElevenLabs key returns an error", () => {
  const { factory } = makeFakeFactory();
  const result = createTranslationPipeline(
    agentConfig({ elevenLabsApiKey: "" }),
    () => factory,
  );
  assert.ok("error" in result);
  assert.match(result.error, /ELEVENLABS_API_KEY/);
});

test("uninitialised ProviderFactory returns an error", () => {
  const result = createTranslationPipeline(agentConfig(), () => {
    throw new Error("ProviderFactory not initialized");
  });
  assert.ok("error" in result);
  assert.match(result.error, /not initialized/);
});

test("translation provider error is surfaced", () => {
  const { factory } = makeFakeFactory();
  (factory as any).getTranslationProvider = () => {
    throw new Error("Mizan credentials not configured");
  };
  const result = createTranslationPipeline(agentConfig(), () => factory);
  assert.ok("error" in result);
  assert.match(result.error, /Mizan credentials not configured/);
});

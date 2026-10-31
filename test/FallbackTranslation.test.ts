import test from "node:test";
import assert from "node:assert/strict";
import { FallbackTranslation } from "../src/providers/FallbackTranslation";
import { MizanTranslation } from "../src/providers/mizan/MizanTranslation";
import type { ITranslationProvider } from "../src/providers/types";

const primary: ITranslationProvider = {
  name: "stub-primary",
  supportedLanguagePairs: [],
  translate: async () => {
    throw new Error("primary down");
  },
  supportsLanguagePair: () => true,
  checkHealth: async () => ({ healthy: true }),
};

const mizan = new MizanTranslation({ username: "u", password: "p" });
mizan.translate = async () => ({
  text: "fallback",
  metadata: { provider: "mizan", targetLanguage: "en", latencyMs: 1 },
}) as any;

test("falls back to Mizan when primary fails and source is auto", async () => {
  const r = await new FallbackTranslation(primary, mizan).translate({
    text: "x",
    sourceLanguage: "",
    targetLanguage: "en",
  });
  assert.equal(r.text, "fallback");
});

test("Mizan rejects auto source for unsupported target", () => {
  assert.equal(mizan.supportsLanguagePair("", "fr"), false);
});

test("Mizan accepts auto source for supported target", () => {
  assert.equal(mizan.supportsLanguagePair("", "en"), true);
});

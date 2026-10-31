import { test } from "node:test";
import assert from "node:assert/strict";
import { TranslationPipeline } from "../src/mizan/TranslationPipeline";
import { makeFakeFactory, flush } from "./helpers/fakes";

test("empty translation skips TTS and is not a circuit-breaker failure", async () => {
  const { factory, stt, ttsCalls } = makeFakeFactory({
    translate: async () => ({ text: "   " }),
  });
  const p = new TranslationPipeline({ providerFactory: factory, targetLanguage: "en" });
  await p.start();
  stt.emit("committed", { text: "how are you feeling today", language: "" });
  await flush();
  assert.equal(ttsCalls.length, 0);
  assert.deepEqual(p.getMetrics(), { processed: 0, failed: 0 });
  p.stop();
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { TranslationPipeline } from "../src/mizan/TranslationPipeline";
import { makeFakeFactory, flush } from "./helpers/fakes";

type Mode = "fail" | "echo" | "ok";

test("sentences that return without a verdict do not wedge a half-open breaker", async () => {
  let mode: Mode = "fail";
  const { factory, stt, ttsCalls } = makeFakeFactory({
    translate: async () => {
      if (mode === "fail") throw new Error("deepl down");
      // "echo": DeepL says the speech was already in the target language
      return mode === "echo"
        ? { text: "same", detectedSourceLanguage: "EN" }
        : { text: "translated" };
    },
  });
  const p = new TranslationPipeline({
    providerFactory: factory,
    targetLanguage: "en",
    tokenBucketCapacity: 1000,
    tokenBucketRefillRate: 1000,
    circuitBreakerOpenTimeoutMs: 30,
  });
  await p.start();
  const say = async (n: number) => {
    for (let i = 0; i < n; i++) {
      stt.emit("committed", { text: `sentence number ${i} please`, language: "" });
      await flush();
    }
  };

  await say(12); // enough failures to open the breaker
  await new Promise((r) => setTimeout(r, 60)); // -> HALF_OPEN

  mode = "echo";
  await say(3); // each returns normally, so each is a success for the breaker

  mode = "ok";
  await say(1);
  assert.equal(ttsCalls.length, 1);
  p.stop();
});

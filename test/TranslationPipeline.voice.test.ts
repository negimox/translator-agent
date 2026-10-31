import { test } from "node:test";
import assert from "node:assert/strict";
import { TranslationPipeline } from "../src/mizan/TranslationPipeline";
import { makeFakeFactory, flush } from "./helpers/fakes";

test("TTS request carries no voiceId so ELEVENLABS_VOICES decides", async () => {
  const { factory, stt, ttsCalls } = makeFakeFactory();
  const p = new TranslationPipeline({
    providerFactory: factory,
    useElevenLabs: true,
    targetLanguage: "hi",
  });
  await p.start();
  stt.emit("committed", { text: "how are you feeling today", language: "eng" });
  await flush();
  assert.equal(ttsCalls.length, 1);
  assert.equal(ttsCalls[0].voiceId, undefined);
  assert.equal(ttsCalls[0].language, "hi");
  p.stop();
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { TranslationPipeline } from "../src/mizan/TranslationPipeline";
import { makeFakeFactory, flush } from "./helpers/fakes";

// 2-language room: this agent speaks "en".
const roomConfig = { targetLanguage: "en" };

async function setup(opts?: Parameters<typeof makeFakeFactory>[0]) {
  const fake = makeFakeFactory(opts);
  const p = new TranslationPipeline({
    providerFactory: fake.factory,
    ...roomConfig,
  });
  await p.start();
  return { ...fake, p };
}

test("does not pin STT language", async () => {
  const { stt, p } = await setup();
  assert.equal(stt.lastOptions?.languageCode, undefined);
  p.stop();
});

test("passes STT-detected language to translation", async () => {
  const { stt, translateCalls, p } = await setup();
  stt.emit("committed", { text: "namaste doctor sahab", language: "hin" });
  await flush();
  assert.equal(translateCalls[0].sourceLanguage, "hi");
  p.stop();
});

test("uses auto-detect when STT gives no language", async () => {
  const { stt, translateCalls, p } = await setup();
  stt.emit("committed", { text: "how are you feeling today", language: "" });
  await flush();
  assert.equal(translateCalls[0].sourceLanguage, "");
  p.stop();
});

test("skips when STT reports target language in ISO-639-3", async () => {
  const { stt, translateCalls, ttsCalls, p } = await setup();
  stt.emit("committed", { text: "how are you feeling today", language: "eng" });
  await flush();
  assert.equal(translateCalls.length, 0);
  assert.equal(ttsCalls.length, 0);
  p.stop();
});

test("discards when DeepL detects target language", async () => {
  const { stt, ttsCalls, p } = await setup({
    translate: async () => ({ text: "same", detectedSourceLanguage: "EN" }),
  });
  stt.emit("committed", { text: "how are you feeling today", language: "" });
  await flush();
  assert.equal(ttsCalls.length, 0);
  p.stop();
});

test("falls back to auto-detect when STT reports a language the provider cannot translate from", async () => {
  const { stt, translateCalls, p } = await setup({
    supports: (source) => ["", "hi", "ur", "ar", "en"].includes(source),
  });
  stt.emit("committed", { text: "kuch bhi kaho yaar", language: "mar" });
  await flush();
  assert.equal(translateCalls.length, 1);
  assert.equal(translateCalls[0].sourceLanguage, "");
  p.stop();
});

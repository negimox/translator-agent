import { test } from "node:test";
import assert from "node:assert/strict";
import { TranslationPipeline } from "../src/mizan/TranslationPipeline";
import { makeFakeFactory } from "./helpers/fakes";

async function started() {
  const fake = makeFakeFactory();
  const p = new TranslationPipeline({
    providerFactory: fake.factory,
    targetLanguage: "en",
  });
  await p.start();
  return { ...fake, p };
}

test("not healthy before start", () => {
  const fake = makeFakeFactory();
  const p = new TranslationPipeline({ providerFactory: fake.factory });
  assert.equal(p.isHealthy(), false);
});

test("healthy after start", async () => {
  const { p } = await started();
  assert.equal(p.isHealthy(), true);
  p.stop();
});

test("unhealthy after STT gives up", async () => {
  const { p, stt } = await started();
  stt.emit("close");
  assert.equal(p.isHealthy(), false);
  p.stop();
});

test("healthy again after reconnect", async () => {
  const { p, stt } = await started();
  stt.emit("close");
  stt.emit("reconnected");
  assert.equal(p.isHealthy(), true);
  p.stop();
});

test("unhealthy after stop", async () => {
  const { p } = await started();
  p.stop();
  assert.equal(p.isHealthy(), false);
});

test("constructor throws without a factory", () => {
  assert.throws(() => new TranslationPipeline({}), /requires a ProviderFactory/);
});

test("hasFailed is true only after STT gives up, cleared by reconnect", async () => {
  const { p, stt } = await started();
  assert.equal(p.hasFailed(), false);
  stt.emit("close");
  assert.equal(p.hasFailed(), true);
  stt.emit("reconnected");
  assert.equal(p.hasFailed(), false);
  p.stop();
});

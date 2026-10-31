import { test } from "node:test";
import assert from "node:assert/strict";
import { TranslationPipeline } from "../src/mizan/TranslationPipeline";
import { makeFakeFactory, flush } from "./helpers/fakes";

// Capacity for exactly one sentence (FULL_PIPELINE = 3 tokens) and a refill
// so slow that later sentences can never be served within the test.
const starved = {
  targetLanguage: "en",
  tokenBucketCapacity: 3,
  tokenBucketRefillRate: 0.001,
};

function say(stt: { emit: (e: string, d: unknown) => boolean }, n: number) {
  for (let i = 0; i < n; i++) {
    stt.emit("committed", { text: `sentence number ${i} please`, language: "" });
  }
}

test("stop() drops waiting sentences without translating", async () => {
  const { factory, stt, translateCalls } = makeFakeFactory();
  const p = new TranslationPipeline({
    providerFactory: factory,
    ...starved,
    maxTokenWaitMs: 60_000, // a leaked timer would keep the process alive this long
  });
  await p.start();
  say(stt, 3);
  await flush();
  assert.equal(translateCalls.length, 1);
  p.stop();
  await flush();
  assert.equal(translateCalls.length, 1);
});

test("sentences older than maxTokenWaitMs are dropped", async () => {
  const { factory, stt, translateCalls } = makeFakeFactory();
  const p = new TranslationPipeline({
    providerFactory: factory,
    ...starved,
    maxTokenWaitMs: 30,
  });
  await p.start();
  say(stt, 2);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(translateCalls.length, 1);
  assert.equal(p.getMetrics().failed, 0); // backpressure is not a circuit-breaker failure
  p.stop();
});

test("pending sentences beyond maxPendingSentences are evicted oldest-first", async () => {
  const { factory, stt, translateCalls } = makeFakeFactory();
  const p = new TranslationPipeline({
    providerFactory: factory,
    ...starved,
    maxPendingSentences: 1,
    maxTokenWaitMs: 60_000,
  });
  await p.start();
  say(stt, 3); // #0 served, #1 queued, #2 evicts #1
  await flush();
  assert.equal(translateCalls.length, 1);
  p.updateRateLimit(3, 1000); // tokens flow again, and waiting sentences are woken
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(translateCalls.length, 2);
  assert.match(translateCalls[1].text, /number 2/);
  p.stop();
});

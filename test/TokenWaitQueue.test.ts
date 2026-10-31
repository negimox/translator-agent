import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { TokenBucket } from "../src/mizan/TokenBucket";
import { TokenWaitQueue } from "../src/mizan/TokenWaitQueue";

async function tick(ms: number) {
  mock.timers.tick(ms);
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function setup(t: { after: (fn: () => void) => void }, cfg = { maxPending: 5, maxWaitMs: 10_000 }) {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(() => mock.timers.reset());
  const bucket = new TokenBucket({ capacity: 3, refillRate: 1 });
  return { bucket, q: new TokenWaitQueue(bucket, cfg) };
}

test("resolves true immediately when tokens available", async (t) => {
  const { q } = setup(t);
  assert.equal(await q.acquire(3), true);
  assert.equal(q.pendingCount, 0);
});

test("FIFO: later waiter is not served before earlier", async (t) => {
  const { q } = setup(t);
  await q.acquire(3);
  const order: string[] = [];
  const a = q.acquire(3).then((v) => order.push("a" + v));
  const b = q.acquire(1).then((v) => order.push("b" + v));
  await tick(1000);
  assert.deepEqual(order, []);
  await tick(2000);
  assert.deepEqual(order, ["atrue"]);
  await tick(1000);
  await Promise.all([a, b]);
  assert.deepEqual(order, ["atrue", "btrue"]);
});

test("evicts oldest when maxPending exceeded", async (t) => {
  const { q } = setup(t, { maxPending: 2, maxWaitMs: 10_000 });
  await q.acquire(3);
  const r: Array<boolean | undefined> = [];
  q.acquire(3).then((v) => (r[0] = v));
  q.acquire(3).then((v) => (r[1] = v));
  q.acquire(3).then((v) => (r[2] = v));
  await tick(0);
  assert.equal(r[0], false);
  assert.equal(q.pendingCount, 2);
  q.cancelAll();
});

test("times out after maxWaitMs", async (t) => {
  const { q } = setup(t, { maxPending: 5, maxWaitMs: 500 });
  await q.acquire(3);
  let res: boolean | undefined;
  q.acquire(3).then((v) => (res = v));
  await tick(501);
  assert.equal(res, false);
  assert.equal(q.pendingCount, 0);
});

test("amount above capacity resolves false at once", async (t) => {
  const { q } = setup(t);
  assert.equal(await q.acquire(4), false);
});

test("cancelAll resolves all pending false and leaves no timers", async (t) => {
  const { q } = setup(t);
  await q.acquire(3);
  const r: boolean[] = [];
  q.acquire(3).then((v) => r.push(v));
  q.acquire(3).then((v) => r.push(v));
  q.cancelAll();
  await tick(0);
  assert.deepEqual(r, [false, false]);
  assert.equal(q.pendingCount, 0);
  // a later tick must not resurrect anything
  await tick(60_000);
  assert.equal(q.pendingCount, 0);
});

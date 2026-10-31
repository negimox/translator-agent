import { test } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker, CircuitState } from "../src/mizan/CircuitBreaker";

function halfOpenBreaker(): CircuitBreaker {
  const cb = new CircuitBreaker({
    errorThreshold: 0.1,
    errorWindowMs: 60000,
    openTimeoutMs: 20,
    minCallsBeforeTripping: 1,
    halfOpenTestCalls: 2,
  });
  cb.recordFailure(); // trips
  return cb;
}

test("releaseRequest returns a half-open slot that was never used", async () => {
  const cb = halfOpenBreaker();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(cb.getState(), CircuitState.HALF_OPEN);
  assert.equal(cb.allowRequest(), true);
  assert.equal(cb.allowRequest(), true);
  assert.equal(cb.allowRequest(), false); // slots exhausted
  cb.releaseRequest();
  assert.equal(cb.allowRequest(), true);
});

test("releaseRequest is a no-op when the circuit is closed", () => {
  const cb = new CircuitBreaker({});
  cb.releaseRequest();
  assert.equal(cb.allowRequest(), true);
});

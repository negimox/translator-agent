import { test } from "node:test";
import assert from "node:assert/strict";
import { computePerAgentRateLimit } from "../src/orchestrator/rateLimit";

test("computePerAgentRateLimit floors capacity at FULL_PIPELINE", () => {
  assert.deepEqual(computePerAgentRateLimit(12, 12, 5), { capacity: 3, refillRate: 2.4 });
  assert.deepEqual(computePerAgentRateLimit(12, 12, 2), { capacity: 6, refillRate: 6 });
});

test("computePerAgentRateLimit treats activeCount <= 0 as 1", () => {
  assert.deepEqual(computePerAgentRateLimit(12, 12, 0), { capacity: 12, refillRate: 12 });
});

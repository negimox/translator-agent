import { test } from "node:test";
import assert from "node:assert/strict";
import { getLivenessStatus, getReadinessStatus } from "../src/health/HealthChecks";
import type { AgentHealthState } from "../src/health/HealthChecks";

function state(overrides: Partial<AgentHealthState> = {}): AgentHealthState {
  return {
    state: "translating",
    healthy: true,
    chrome: true,
    audioContext: "running",
    captureActive: true,
    outputActive: true,
    heartbeatHealthy: true,
    meetingConnected: true,
    pipelineHealthy: true,
    uptime: 10,
    ...overrides,
  } as AgentHealthState;
}

test("liveness fails when the pipeline has permanently failed", () => {
  assert.equal(getLivenessStatus(state({ pipelineFailed: true })).healthy, false);
});

test("liveness stays healthy when the pipeline is merely disabled", () => {
  const s = state({ pipelineHealthy: false, pipelineFailed: false });
  assert.equal(getLivenessStatus(s).healthy, true);
  assert.equal(getReadinessStatus(s).healthy, false);
});

test("liveness is healthy when pipelineFailed is absent", () => {
  assert.equal(getLivenessStatus(state()).healthy, true);
});

import { MIZAN_TOKEN_COSTS } from "../mizan/TokenBucket";

/**
 * Splits the global token bucket across active agents, never giving an agent
 * less capacity than one full pipeline run.
 */
export function computePerAgentRateLimit(
  globalCapacity: number,
  globalRefillRate: number,
  activeCount: number,
): { capacity: number; refillRate: number } {
  const n = activeCount > 0 ? activeCount : 1;
  return {
    capacity: Math.max(globalCapacity / n, MIZAN_TOKEN_COSTS.FULL_PIPELINE),
    refillRate: globalRefillRate / n,
  };
}

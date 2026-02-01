/**
 * Health check types and functions.
 */

import { AgentState } from '../agent/TranslatorAgent';

/**
 * Detailed health status of the agent.
 */
export interface AgentHealthState {
    state: AgentState;
    healthy: boolean;
    chrome: boolean;
    audioContext: 'suspended' | 'running' | 'closed';
    captureActive: boolean;
    outputActive: boolean;
    heartbeatHealthy: boolean;
    meetingConnected: boolean;
    uptime: number;
}

/**
 * Simple health status for probes.
 */
export interface HealthStatus {
    healthy: boolean;
    ready: boolean;
    details?: AgentHealthState;
}

/**
 * Generates a liveness probe response.
 * Checks if the agent process is alive and Chrome is running.
 */
export function getLivenessStatus(healthState: AgentHealthState): HealthStatus {
    return {
        healthy: healthState.chrome,
        ready: healthState.chrome,
    };
}

/**
 * Generates a readiness probe response.
 * Checks if the agent is ready to process audio.
 */
export function getReadinessStatus(healthState: AgentHealthState): HealthStatus {
    const ready = 
        healthState.chrome &&
        healthState.audioContext === 'running' &&
        healthState.captureActive &&
        healthState.outputActive &&
        healthState.heartbeatHealthy &&
        healthState.meetingConnected;

    return {
        healthy: ready,
        ready,
        details: healthState,
    };
}

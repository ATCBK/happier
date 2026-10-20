import type { AgentSessionRuntime } from '../../agentRuntime/session.js';
import type { AgentSessionRealtimeConversation } from './realtimeContracts.js';
export type {
    AgentSessionRealtimeAvailability, AgentSessionRealtimeStartInput,
    AgentSessionRealtimeLifecycleEvent, AgentSessionRealtimeStopResult,
    AgentSessionRealtimeHandle, AgentSessionRealtimeStartResult, AgentSessionRealtimeConversation,
} from './realtimeContracts.js';

export interface ExperimentalAgentSessionRealtimeRuntime extends AgentSessionRuntime {
    readonly realtimeConversation: AgentSessionRealtimeConversation;
}

/**
 * Validates the extension only after a normalized contribution declaration has explicitly
 * selected `experimental_agent_session_realtime`. It is not an ambient capability probe.
 */
export function assertExperimentalAgentSessionRealtimeRuntime(
    value: unknown,
): ExperimentalAgentSessionRealtimeRuntime {
    if (!value || typeof value !== 'object') {
        throw new TypeError('Malformed experimental Agent session realtime runtime');
    }
    const runtime = value as Partial<ExperimentalAgentSessionRealtimeRuntime>;
    const realtime = runtime.realtimeConversation;
    if (
        typeof runtime.send !== 'function'
        || typeof runtime.watch !== 'function'
        || typeof runtime.dispose !== 'function'
        || !realtime
        || typeof realtime.inspect !== 'function'
        || typeof realtime.start !== 'function'
    ) {
        throw new TypeError('Malformed experimental Agent session realtime runtime');
    }
    return runtime as ExperimentalAgentSessionRealtimeRuntime;
}

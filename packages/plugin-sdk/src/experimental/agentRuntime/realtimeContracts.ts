import type { PluginDiagnosticData } from '../../diagnostics.js';
import type { Disposable } from '../../lifecycle.js';

export type AgentSessionRealtimeAvailability =
    | Readonly<{ status: 'available'; transport: 'webrtc' }>
    | Readonly<{
        status: 'unavailable';
        reason: 'authentication_required' | 'session_unavailable' | 'unsupported_runtime' | 'update_required' | 'feature_unavailable';
        diagnostic: PluginDiagnosticData;
    }>;

export type AgentSessionRealtimeStartInput = Readonly<{
    transport: Readonly<{ kind: 'webrtc'; offerSdp: string }>;
    /** Host-prepared exact-Session context, not accepted from the public RPC. */
    systemAppendBlocks?: readonly string[];
}>;

export type AgentSessionRealtimeLifecycleEvent = Readonly<{
    kind: 'terminal';
    reason: 'stopped' | 'upstream_closed' | 'agent_session_disposed' | 'aborted' | 'error';
    diagnostic?: PluginDiagnosticData;
}>;

export type AgentSessionRealtimeStopResult =
    | Readonly<{ status: 'stopped' | 'already_stopped' | 'aborted' }>
    | Readonly<{ status: 'unavailable'; diagnostic: PluginDiagnosticData }>;

export interface AgentSessionRealtimeHandle extends Disposable {
    stop(options?: Readonly<{ signal?: AbortSignal }>): Promise<AgentSessionRealtimeStopResult>;
    watch(listener: (event: AgentSessionRealtimeLifecycleEvent) => void): Disposable;
    dispose(): void | Promise<void>;
}

export type AgentSessionRealtimeStartResult =
    | Readonly<{
        status: 'started';
        transport: Readonly<{ kind: 'webrtc'; answerSdp: string }>;
        handle: AgentSessionRealtimeHandle;
    }>
    | Readonly<{ status: 'busy' | 'aborted' }>
    | Readonly<{ status: 'unavailable' | 'failed'; diagnostic: PluginDiagnosticData }>;

export interface AgentSessionRealtimeConversation {
    inspect(options?: Readonly<{ signal?: AbortSignal }>): Promise<AgentSessionRealtimeAvailability>;
    start(input: AgentSessionRealtimeStartInput, options?: Readonly<{ signal?: AbortSignal }>): Promise<AgentSessionRealtimeStartResult>;
}

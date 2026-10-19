import { randomUUID } from 'node:crypto';
import type {
  BridgeLifecycleHookEventIdV1,
  HookEventEnvelopeV1,
  HookScopeV1,
  PluginHookPayloadMapV1,
} from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';

import { configuration } from '@/configuration';
import { HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY,
  readCurrentRunnerAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { dispatchCurrentAgentRuntimeDaemonServiceRequest } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceAuthorityClient';

import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
  acquireAuthoritativePluginRuntimeRegistryLease,
  createEphemeralPluginRuntimeRegistryLease,
} from '@/plugins/runtime/reload/runtimeLease';

import {
  dispatchPluginHookEvent,
  type DispatchPluginHookEventResultV1,
} from './dispatchPluginHookEvent';

type DispatchBridgeLifecycleHookEventDeps = Readonly<{
  resolveRuntimeRegistry?: (params: Readonly<{ happyHomeDir: string }>) => Promise<ResolvedExecutablePluginRuntimeRegistry>;
  dispatchEvent?: (params: Readonly<{
    runtimeRegistry: Pick<ResolvedExecutablePluginRuntimeRegistry, 'hookHandlersByHookId'>;
    event: HookEventEnvelopeV1;
  }>) => Promise<DispatchPluginHookEventResultV1>;
  nowMs?: () => number;
}>;

type BridgeLifecycleHookDispatchMetadata = Readonly<{
  scope?: HookScopeV1;
  happySessionId?: string;
  agentSessionId?: string;
  agentId?: string;
  backendTarget?: string;
  machineId?: string;
  workspaceId?: string;
  cwd?: string;
  turnId?: string;
  toolCallId?: string;
  timestampMs?: number;
}>;

export type BridgeLifecycleHookDispatchEvent = {
  [THookId in BridgeLifecycleHookEventIdV1]: Readonly<BridgeLifecycleHookDispatchMetadata & {
    eventId: THookId;
    payload: Omit<PluginHookPayloadMapV1[THookId], 'timestampMs'> & Readonly<{ timestampMs?: number }>;
  }>;
}[BridgeLifecycleHookEventIdV1];

export async function dispatchBridgeLifecycleHookEvent(
  params: Readonly<{
    happyHomeDir: string;
    event: BridgeLifecycleHookDispatchEvent;
  }>,
  deps: DispatchBridgeLifecycleHookEventDeps = {},
): Promise<DispatchPluginHookEventResultV1> {
  const dispatchEvent = deps.dispatchEvent ?? dispatchPluginHookEvent;
  const nowMs = deps.nowMs ?? (() => Date.now());

  const timestampMs = typeof params.event.timestampMs === 'number' ? params.event.timestampMs : nowMs();
  const event: HookEventEnvelopeV1 = {
    hookVersion: 1,
    eventId: params.event.eventId,
    category: 'lifecycle',
    scope: params.event.scope ?? 'session',
    ...(params.event.happySessionId ? { happySessionId: params.event.happySessionId } : {}),
    ...(params.event.agentSessionId ? { agentSessionId: params.event.agentSessionId } : {}),
    ...(params.event.agentId ? { agentId: params.event.agentId } : {}),
    ...(params.event.backendTarget ? { backendTarget: params.event.backendTarget } : {}),
    ...(params.event.machineId ? { machineId: params.event.machineId } : {}),
    ...(params.event.workspaceId ? { workspaceId: params.event.workspaceId } : {}),
    ...(params.event.cwd ? { cwd: params.event.cwd } : {}),
    ...(params.event.turnId ? { turnId: params.event.turnId } : {}),
    ...(params.event.toolCallId ? { toolCallId: params.event.toolCallId } : {}),
    timestampMs,
    payload: { ...params.event.payload, timestampMs },
  };

  const authorityPath = process.env[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY];
  if (authorityPath && !deps.resolveRuntimeRegistry) {
    const current = await readCurrentRunnerAgentRuntimeDaemonServiceAuthority({
      happyHomeDir: params.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing, path: authorityPath,
    });
    if (!current) throw new PluginError({ code: 'plugin_hook_dispatch_unavailable', message: 'Runner lifecycle hooks are unavailable' });
    // The event may describe a spawned child; the issuing runner's Session,
    // rather than the event's target Session, owns the authenticated request.
    const response = await dispatchCurrentAgentRuntimeDaemonServiceRequest({
      // The existing hook dispatcher awaits observers without a local deadline.
      timeoutMs: null,
      authority: { happyHomeDir: params.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
        path: authorityPath, sessionId: current.sessionId, runner: current.runner, retainedAgent: current.retainedAgent },
      createRequest: token => ({ v: 1, context: { token, sessionId: current.sessionId },
        operation: { kind: 'turn_contributions.resolve', requestId: randomUUID(), request: { kind: 'lifecycleHook', event } } }),
    });
    if (response.ok && response.result.kind === 'turn_contributions' && response.result.contributions.kind === 'lifecycleHook') {
      return response.result.contributions.result;
    }
    // Observers can perform effects. A lost response must not replay the hook
    // or fall back to another registry in the runner process.
    throw new PluginError({ code: 'plugin_hook_dispatch_unavailable', message: 'Runner lifecycle hooks are unavailable' });
  }

  const lease = deps.resolveRuntimeRegistry
    ? await (async () => {
      const registry = await deps.resolveRuntimeRegistry!({ happyHomeDir: params.happyHomeDir });
      return createEphemeralPluginRuntimeRegistryLease(registry);
    })()
    : await acquireAuthoritativePluginRuntimeRegistryLease({ happyHomeDir: params.happyHomeDir });
  try {
    return await dispatchEvent({
      runtimeRegistry: lease.registry,
      event,
    });
  } finally {
    await lease.release();
  }
}

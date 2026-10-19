import { describe, expect, it, vi } from 'vitest';

import type { AgentRuntime, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type {
  ResolvedAgentContribution,
  ResolvedAgentRuntimeContribution,
} from '@/plugins/projection/registry/types';

import { createEmptyBackendExecutionSurfaces } from '../engineRegistryTypes';
import type { NativeAgentSessionRunToolBindingRequest } from '../engineRegistryTypes';
import { resolveBackendRuntimeCore } from './runtimeCore';

const AGENT_ID = 'acme.session-agent';

function createContributions() {
  return {
    backend: {
      id: AGENT_ID,
      agentId: AGENT_ID,
      provenance: 'external',
      source: { kind: 'path' },
      definition: { kindVersion: 1, id: AGENT_ID, agentId: AGENT_ID },
      pluginId: AGENT_ID,
    } as unknown as ResolvedAgentRuntimeContribution,
    agent: {
      id: AGENT_ID,
      identity: { pluginId: AGENT_ID, localId: AGENT_ID },
      provenance: 'external',
      source: { kind: 'path' },
      definition: { kindVersion: 1, id: AGENT_ID, ownedBackendIds: [AGENT_ID] },
      richDefinition: {
        provenance: 'external',
        definition: {
          id: AGENT_ID,
          title: { key: 'agents.acme.title', fallback: 'Acme' },
          description: { key: 'agents.acme.description', fallback: 'Acme' },
          runtime: { kind: 'custom' },
          primary: 'sessions',
          capabilities: {
            sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true },
          },
        },
      },
      pluginId: AGENT_ID,
    } as unknown as ResolvedAgentContribution,
  };
}

describe('resolveBackendRuntimeCore Session Run read Actions', () => {
  it('publishes the exact admitted Run tool snapshot with the runtime occurrence lifetime', async () => {
    const { backend, agent } = createContributions();
    const publishSupportedSessionReadActions = vi.fn();
    const composeRunToolBinding = vi.fn(async (_request: NativeAgentSessionRunToolBindingRequest) => ({
      mcpServers: { happier: { command: 'happier-mcp', args: ['--run', 'run-a'] } },
      supportedSessionReadActions: [
        'session.transcript.get' as const,
        'discussion.read' as const,
      ],
      dispose: () => undefined,
    }));
    let openedContext: AgentSessionRuntimeContext | null = null;
    const open = vi.fn(async (_request: unknown, context: AgentSessionRuntimeContext) => {
      openedContext = context;
      throw new Error('stop-after-open-request');
    });

    const adapter = await resolveBackendRuntimeCore({
      backend,
      agent,
      executionSurfaces: createEmptyBackendExecutionSurfaces(),
      runtimeOwner: {
        backendId: AGENT_ID,
        selected: { kind: 'plugin_engine', ownerId: AGENT_ID, provenance: 'external', pluginId: AGENT_ID },
        candidates: [],
      },
      nativeAgentRuntime: { sessions: { open } } as unknown as AgentRuntime,
      nativeAgentRuntimeIdentity: {
        pluginId: AGENT_ID,
        pluginVersion: '1.0.0',
        agentId: AGENT_ID,
        generation: 'agent-generation',
        isCurrent: () => true,
      },
    } as never);

    const parentSession = {
      sessionId: 'session-a',
      getMetadataSnapshot: () => ({ path: '/parent', machineId: 'machine-a' }),
      updateMetadata: async () => undefined,
      updateAgentState: async () => undefined,
      enqueueAgentMessageCommitted: async () => ({ persisted: true }),
    };
    const runtimeLifetime = new AbortController();
    const runtime = adapter?.runtimeCore.createExecutionRunBackend({
      scope: 'session_owned',
      cwd: '/run/a',
      runId: 'run-a',
      controllerOccurrenceId: 'run-a-occurrence',
      callId: 'run-a-call',
      sidechainId: 'sidechain-a',
      backendId: AGENT_ID,
      permissionMode: 'default',
      start: { intent: 'delegate', runClass: 'long_lived', retentionPolicy: 'resumable' },
      sessionInteractionHost: {
        session: parentSession,
        machineId: 'machine-a',
        permissionHandler: {
          handleToolCall: async () => ({ decision: 'approved' }),
          abortPendingRequestAndFlush: async () => undefined,
        },
        composeRunToolBinding,
      },
      sessionOwnedRunScope: {
        runId: 'run-a',
        workDepth: 0,
        sidechainId: 'sidechain-a',
        readCurrentRunOccurrence: () => null,
        publishSupportedSessionReadActions,
        projectRunTranscriptSession: () => parentSession,
      },
      signal: runtimeLifetime.signal,
    } as never);
    expect(runtime).toBeTruthy();

    await expect(runtime!.provisionRuntime()).rejects.toThrow('stop-after-open-request');

    expect(openedContext).toBeTruthy();
    expect(composeRunToolBinding).toHaveBeenCalledTimes(1);
    expect(publishSupportedSessionReadActions).toHaveBeenCalledWith(
      ['session.transcript.get', 'discussion.read'],
      expect.any(AbortSignal),
    );
  });
});

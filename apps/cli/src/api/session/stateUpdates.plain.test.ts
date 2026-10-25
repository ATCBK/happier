import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  updateSessionAgentStateWithAck,
  updateSessionMetadataWithAck,
  updateSessionRuntimeActivityProjectionWithAck,
} from './stateUpdates';
import { logger } from '@/ui/logger';
import type { Metadata } from '@/api/types';

type PlainMetadataAckPayload = {
  metadata: string;
  expectedVersion: number;
};

function createMetadata(overrides: Partial<Metadata> = {}): Metadata {
  return {
    path: '/tmp',
    host: 'localhost',
    homeDir: '/home/test',
    happyHomeDir: '/home/test/.happier',
    happyLibDir: '/home/test/.happier/lib',
    happyToolsDir: '/home/test/.happier/tools',
    ...overrides,
  };
}

describe('stateUpdates (plaintext sessions)', () => {
  afterEach(() => vi.useRealTimers());

  const writeKinds = ['metadata', 'agent-state', 'runtime-activity'] as const;
  function startWrite(kind: typeof writeKinds[number], socket: { emitWithAck: (event: string, payload: unknown) => Promise<unknown> }, signal?: AbortSignal) {
    const common = { socket, sessionId: 's1', signal };
    if (kind === 'runtime-activity') {
      return updateSessionRuntimeActivityProjectionWithAck({ ...common,
        mutationId: 'runtime-activity-snapshot:s1', state: 'active', runtimeActivityActiveCount: 1 });
    }
    if (kind === 'agent-state') {
      return updateSessionAgentStateWithAck({ ...common, sessionEncryptionMode: 'plain',
        getAgentState: () => ({}), setAgentState: () => {}, getAgentStateVersion: () => 1,
        setAgentStateVersion: () => {}, syncSessionSnapshotFromServer: async () => {},
        handler: (current) => current });
    }
    return updateSessionMetadataWithAck({ ...common, sessionEncryptionMode: 'plain',
      getMetadata: () => createMetadata(), setMetadata: () => {}, getMetadataVersion: () => 1,
      setMetadataVersion: () => {}, syncSessionSnapshotFromServer: async () => {},
      handler: (current) => current });
  }

  it.each(writeKinds)('keeps %s publication pending until the containing server operation acknowledges', async (kind) => {
    vi.useFakeTimers();
    let acknowledge!: (response: unknown) => void;
    const socket = { emitWithAck: vi.fn(() => new Promise<unknown>((resolve) => { acknowledge = resolve; })) };
    let settled = false;
    const result = startWrite(kind, socket).then(value => { settled = true; return value; }, error => { settled = true; throw error; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);
    // A shorter transport timer must not retry a write the server still owns.
    expect(socket.emitWithAck).toHaveBeenCalledTimes(1);
    acknowledge(kind === 'runtime-activity' ? {
      status: 'applied', sessionId: 's1', mutationId: 'runtime-activity-snapshot:s1',
      projection: { state: 'active', activeCount: 1, observedAt: 1_000, revision: 1 },
    } : { result: 'success', version: 2, metadata: '{}', agentState: '{}' });
    await expect(result).resolves.toMatchObject(kind === 'runtime-activity' ? { disposition: 'applied' } : { version: 2 });
  });

  it.each(writeKinds)('cancels %s publication at Session disposal without retrying it', async (kind) => {
    vi.useFakeTimers();
    const cancellation = new AbortController();
    const socket = { emitWithAck: vi.fn(() => new Promise<unknown>(() => {})) };
    let rejection: unknown;
    const result = startWrite(kind, socket, cancellation.signal).catch(error => { rejection = error; });
    await vi.advanceTimersByTimeAsync(0);
    cancellation.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(rejection).toMatchObject({ name: 'SocketAckAbortError', retryable: false });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.emitWithAck).toHaveBeenCalledTimes(1);
    await result;
  });

  it.each(['metadata', 'agent-state'] as const)('reconciles an uncertain %s CAS by its exact submitted value before reapplying the mutation', async (kind) => {
    let committed: { value: string; version: number } | undefined;
    const socket = { emitWithAck: vi.fn(async (_event: string, payload: unknown) => {
      const request = payload as { metadata?: string; agentState?: string; expectedVersion: number };
      const value = request.metadata ?? request.agentState!;
      if (!committed) {
        committed = { value, version: request.expectedVersion + 1 };
        throw new Error('socket has been disconnected');
      }
      if (request.expectedVersion < committed.version) {
        return { result: 'version-mismatch', version: committed.version, metadata: committed.value, agentState: committed.value };
      }
      committed = { value, version: request.expectedVersion + 1 };
      return { result: 'success', version: committed.version, metadata: value, agentState: value };
    }) };
    let version = 1;
    let metadata = createMetadata({ name: 'title' });
    let agentState: import('@/api/types').AgentState = { requests: {} };
    const result = kind === 'metadata'
      ? await updateSessionMetadataWithAck({ socket, sessionId: 's1', sessionEncryptionMode: 'plain',
        getMetadata: () => metadata, setMetadata: value => { metadata = value!; },
        getMetadataVersion: () => version, setMetadataVersion: value => { version = value; },
        syncSessionSnapshotFromServer: async () => {}, handler: value => ({ ...value, name: `${value.name}!` }) })
      : await updateSessionAgentStateWithAck({ socket, sessionId: 's1', sessionEncryptionMode: 'plain',
        getAgentState: () => agentState, setAgentState: value => { agentState = value!; },
        getAgentStateVersion: () => version, setAgentStateVersion: value => { version = value; },
        syncSessionSnapshotFromServer: async () => {}, handler: value => ({ ...value,
          requests: { ...value.requests, [`r${Object.keys(value.requests ?? {}).length}`]: { tool: 'Read', arguments: {}, createdAt: 1 } } }) });
    expect(result.version).toBe(2);
    expect(version).toBe(2);
    expect(kind === 'metadata' ? metadata.name : Object.keys(agentState.requests ?? {})).toEqual(kind === 'metadata' ? 'title!' : ['r0']);
  });

  it.each(['metadata', 'agent-state'] as const)('reoffers the exact uncertain %s CAS through the replacement Session transport', async (kind) => {
    let stored = '';
    let version = 1;
    let metadata = createMetadata({ name: 'title' });
    let agentState: import('@/api/types').AgentState = { requests: {} };
    const submitted: unknown[] = [];
    const replacement = { emitWithAck: async (_event: string, payload: unknown) => {
      submitted.push(payload);
      return { result: 'version-mismatch', version: 2, metadata: stored, agentState: stored };
    } };
    const disconnected = { emitWithAck: async (_event: string, payload: unknown) => {
      // The database and socket are external boundaries; the CAS owner stays real.
      submitted.push(payload);
      const request = payload as { metadata?: string; agentState?: string };
      stored = request.metadata ?? request.agentState!;
      current = replacement;
      throw new Error('socket has been disconnected');
    } };
    let current: Parameters<typeof updateSessionMetadataWithAck>[0]['socket'] = disconnected;
    const common = { socket: disconnected, getSocket: () => current,
      sessionId: 's1', sessionEncryptionMode: 'plain' as const,
      syncSessionSnapshotFromServer: async () => {} };
    const result = kind === 'metadata'
      ? await updateSessionMetadataWithAck({ ...common,
        getMetadata: () => metadata, setMetadata: value => { metadata = value!; },
        getMetadataVersion: () => version, setMetadataVersion: value => { version = value; },
        handler: value => ({ ...value, name: `${value.name}!` }) })
      : await updateSessionAgentStateWithAck({ ...common,
        getAgentState: () => agentState, setAgentState: value => { agentState = value!; },
        getAgentStateVersion: () => version, setAgentStateVersion: value => { version = value; },
        handler: value => ({ ...value, requests: { ...value.requests,
          [`r${Object.keys(value.requests ?? {}).length}`]: { tool: 'Read', arguments: {}, createdAt: 1 } } }) });
    expect(result.version).toBe(2);
    expect(version).toBe(2);
    expect(submitted).toHaveLength(2);
    expect(submitted[1]).toEqual(submitted[0]);
    expect(kind === 'metadata' ? metadata.name : Object.keys(agentState.requests ?? {}))
      .toEqual(kind === 'metadata' ? 'title!' : ['r0']);
  });

  it('reports terminal metadata write failure without leaking the rejected payload or changing local state', async () => {
    const infoFile = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const original = createMetadata();
    let metadata: Metadata | null = original;
    let version = 7;
    try {
      await expect(updateSessionMetadataWithAck({
        socket: { emitWithAck: async () => ({ result: 'error', error: 'private-server-payload' }) },
        sessionId: 's1',
        sessionEncryptionMode: 'plain',
        getMetadata: () => metadata,
        setMetadata: (next) => { metadata = next; },
        getMetadataVersion: () => version,
        setMetadataVersion: (next) => { version = next; },
        syncSessionSnapshotFromServer: async () => {},
        handler: (current) => ({ ...current, name: 'private-session-title' }),
      })).rejects.toMatchObject({ code: 'metadata_update_failed', retryable: false });
      expect(metadata).toBe(original);
      expect(version).toBe(7);
      expect(infoFile).toHaveBeenCalledWith('[API] session_metadata_update_failed', {
        phase: 'terminal_failure', operation: 'update-metadata', sessionId: 's1',
      });
      expect(JSON.stringify(infoFile.mock.calls)).not.toContain('private-server-payload');
      expect(JSON.stringify(infoFile.mock.calls)).not.toContain('private-session-title');
    } finally {
      infoFile.mockRestore();
    }
  });

  it('reports a settled agent-state write failure without logging private state or server payloads', async () => {
    const privateServerError = 'private server response /private/workspace';
    const agentState: import('@/api/types').AgentState = {
      requests: { pending: { tool: 'Bash', arguments: { command: 'private command' }, createdAt: 1 } },
    };
    const infoFile = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    try {
      await expect(updateSessionAgentStateWithAck({
        socket: { emitWithAck: async () => ({ result: 'error', error: privateServerError }) },
        sessionId: 's1',
        sessionEncryptionMode: 'plain',
        getAgentState: () => agentState,
        setAgentState: () => { throw new Error('failed write must not replace the acknowledged snapshot'); },
        getAgentStateVersion: () => 1,
        setAgentStateVersion: () => { throw new Error('failed write must not advance the version'); },
        syncSessionSnapshotFromServer: async () => {},
        handler: (current) => ({ ...current, requests: {} }),
      })).rejects.toMatchObject({ code: 'agent_state_update_failed', retryable: false });
      expect(infoFile.mock.calls).toEqual([[
        '[API] session_agent_state_update_failed',
        { phase: 'terminal_failure', operation: 'update-state', sessionId: 's1' },
      ]]);
      expect(JSON.stringify(infoFile.mock.calls)).not.toContain(privateServerError);
      expect(JSON.stringify(infoFile.mock.calls)).not.toContain('private command');
    } finally {
      infoFile.mockRestore();
    }
  });

  it('keeps flat Herdr metadata readable on the wire without changing the local host or opaque fields', async () => {
    let metadata: Metadata & { providerExtension?: { retained: boolean } } = {
      ...createMetadata({
      terminal: { mode: 'herdr', requested: 'herdr', herdr: { sessionName: 'work', socketPath: '/tmp/herdr.sock', terminalId: 'term_1' } },
      }),
      providerExtension: { retained: true },
    };
    const original = metadata;
    let version = 1;
    let wireMetadata: unknown;
    const result = await updateSessionMetadataWithAck({
      socket: { emitWithAck: async (_event: string, payload: PlainMetadataAckPayload) => {
        wireMetadata = JSON.parse(payload.metadata);
        return { result: 'success', version: 2, metadata: payload.metadata };
      } },
      sessionId: 's1', sessionEncryptionMode: 'plain',
      getMetadata: () => metadata, setMetadata: (next) => { metadata = next ?? createMetadata(); },
      getMetadataVersion: () => version, setMetadataVersion: (next) => { version = next; },
      syncSessionSnapshotFromServer: async () => {}, handler: (current) => ({ ...current, name: 'renamed' }),
    });
    expect(wireMetadata).toMatchObject({
      terminal: { mode: 'plain', hostKind: 'herdr', requested: 'plain', requestedHostKind: 'herdr' },
      providerExtension: { retained: true },
    });
    expect(result.metadata.terminal).toEqual(original.terminal);
    expect(result.metadata).toHaveProperty('providerExtension', { retained: true });
    expect(result.metadata.terminal).not.toHaveProperty('hostKind');
  });

  it('sends runtime activity through its public projection socket mutation only', async () => {
    const emitWithAck = vi.fn(async (_event: string, payload: any) => ({
      status: 'applied',
      sessionId: payload.sessionId,
      mutationId: payload.mutationId,
      projection: {
        state: payload.snapshot.state,
        activeCount: payload.snapshot.activeCount,
        observedAt: 1_000,
        revision: 1,
      },
    }));

    await updateSessionRuntimeActivityProjectionWithAck({
      socket: { emitWithAck },
      sessionId: 's1',
      mutationId: 'runtime-activity-snapshot:s1',
      state: 'active',
      runtimeActivityActiveCount: 1,
    });

    expect(emitWithAck).toHaveBeenCalledWith('session-runtime-activity-snapshot', {
      sessionId: 's1',
      mutationId: 'runtime-activity-snapshot:s1',
      snapshot: {
        state: 'active',
        activeCount: 1,
      },
    });
    const [, payload] = emitWithAck.mock.calls[0]!;
    expect(payload).not.toHaveProperty('thinking');
    expect(payload).not.toHaveProperty('activeAt');
    expect(payload).not.toHaveProperty('latestTurnStatus');
    expect(payload).not.toHaveProperty('meaningfulActivityAt');
    expect(payload).not.toHaveProperty('metadata');
    expect(payload).not.toHaveProperty('agentState');
  });

  it('raises a typed retryable error when runtime activity projection writes fail', async () => {
    const socket = {
      emitWithAck: vi.fn(async () => ({
        result: 'error',
        error: 'internal',
      })),
    };

    await expect(updateSessionRuntimeActivityProjectionWithAck({
      socket,
      sessionId: 's1',
      mutationId: 'runtime-activity-snapshot:s1',
      state: 'active',
      runtimeActivityActiveCount: 1,
    })).rejects.toMatchObject({
      code: 'runtime_activity_update_failed',
      retryable: true,
    });
  });

  it('sends + applies plaintext metadata updates when session encryption mode is plain', async () => {
    const emitWithAck = vi.fn(async (_event: string, payload: any) => {
      expect(typeof payload.metadata).toBe('string');
      expect(payload.metadata).toContain('"path":"');
      return {
        result: 'success',
        metadata: payload.metadata,
        version: payload.expectedVersion + 1,
      };
    });

    const socket = { emitWithAck };

    let metadata: any = { path: '/tmp', host: 'localhost' };
    let version = 1;

    await updateSessionMetadataWithAck({
      socket,
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      getMetadata: () => metadata,
      setMetadata: (next) => {
        metadata = next;
      },
      getMetadataVersion: () => version,
      setMetadataVersion: (next) => {
        version = next;
      },
      syncSessionSnapshotFromServer: async () => {},
      handler: (current) => ({ ...current, path: '/tmp2' }),
    });

    expect(metadata.path).toBe('/tmp2');
    expect(version).toBe(2);
  });

  it('projects predecessor Agent aliases only onto the socket wire payload', async () => {
    let wireMetadata: Record<string, unknown> | null = null;
    const emitWithAck = vi.fn(async (
      _event: string,
      payload: PlainMetadataAckPayload,
    ) => {
      wireMetadata = JSON.parse(payload.metadata) as Record<string, unknown>;
      return {
        result: 'success',
        metadata: payload.metadata,
        version: payload.expectedVersion + 1,
      };
    });
    let metadata = createMetadata();
    let version = 1;

    const result = await updateSessionMetadataWithAck({
      socket: { emitWithAck },
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      getMetadata: () => metadata,
      setMetadata: (next) => {
        metadata = next ?? createMetadata();
      },
      getMetadataVersion: () => version,
      setMetadataVersion: (next) => {
        version = next;
      },
      syncSessionSnapshotFromServer: async () => {},
      handler: (current) => ({
        ...current,
        sessionModelsV1: {
          v: 1,
          agentId: 'codex',
          updatedAt: 1,
          currentModelId: 'codex-1',
          availableModels: [{ id: 'codex-1', name: 'Codex 1' }],
        },
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: {
            backendMode: 'appServer',
            providerSessionId: 'thread-private',
          },
        },
        forkV1: {
          v: 1,
          parentSessionId: 'parent-session',
          parentCutoffSeqInclusive: 42,
          createdAtMs: 2,
          strategy: 'provider_native',
          agentHint: {
            agentId: 'codex',
            backendMode: 'appServer',
            agentSessionId: 'thread-private',
          },
        },
      }),
    });

    expect(wireMetadata).toMatchObject({
      sessionModelsV1: { provider: 'codex' },
      agentRuntimeDescriptorV1: {
        providerId: 'codex',
        provider: { vendorSessionId: 'thread-private' },
      },
      forkV1: {
        providerHint: {
          providerId: 'codex',
          vendorSessionId: 'thread-private',
        },
      },
    });
    expect(metadata.sessionModelsV1).toMatchObject({ agentId: 'codex' });
    expect(metadata.sessionModelsV1).not.toHaveProperty('provider');
    expect(metadata).not.toHaveProperty('agentRuntimeDescriptorV1');
    expect(metadata).not.toHaveProperty('forkV1.providerHint');
    expect(result.metadata).toEqual(metadata);
    expect(version).toBe(2);
  });

  it('logs currentModeId from the canonical sessionModesV1 metadata key', async () => {
    const emitWithAck = vi.fn(async (_event: string, payload: any) => ({
      result: 'success',
      metadata: payload.metadata,
      version: payload.expectedVersion + 1,
    }));

    const socket = { emitWithAck };
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    let metadata: any = { path: '/tmp', host: 'localhost' };
    let version = 1;

    await updateSessionMetadataWithAck({
      socket,
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      getMetadata: () => metadata,
      setMetadata: (next) => {
        metadata = next;
      },
      getMetadataVersion: () => version,
      setMetadataVersion: (next) => {
        version = next;
      },
      syncSessionSnapshotFromServer: async () => {},
      handler: (current) => ({
        ...current,
        sessionModesV1: {
          v: 1,
          agentId: 'codex',
          updatedAt: 1,
          currentModeId: 'plan',
          availableModes: [{ id: 'plan', name: 'Plan' }],
        },
      }),
    });

    expect(debugSpy).toHaveBeenCalledWith(
      '[API] updateMetadata attempting',
      expect.objectContaining({ currentModeId: 'plan' }),
    );
    expect(debugSpy).toHaveBeenCalledWith(
      '[API] updateMetadata success',
      expect.objectContaining({ currentModeId: 'plan' }),
    );

    debugSpy.mockRestore();
  });

  it('sends projected request counts with update-state payloads', async () => {
    const emitWithAck = vi.fn(async (_event: string, payload: any) => {
      expect(payload.activitySummaryV1).toEqual({
        ownerActivityDelivery: 'rich_sender',
        pendingPermissionRequestCount: 1,
        pendingUserActionRequestCount: 1,
        pendingRequestNewestCreatedAt: 2,
        newUserActionRequiredOccurrences: [
          {
            requestId: 'req_permission',
            sourceTurnId: 'turn_1',
            requestKind: 'permission',
            occurredAt: 1,
            followEvent: { kind: 'needs_you', type: 'approval' },
          },
          {
            requestId: 'req_action',
            sourceTurnId: 'turn_1',
            requestKind: 'user_action',
            occurredAt: 2,
            followEvent: { kind: 'needs_you', type: 'decision' },
          },
        ],
      });
      return {
        result: 'success',
        agentState: payload.agentState,
        version: payload.expectedVersion + 1,
      };
    });

    const socket = { emitWithAck };

    let agentState: any = { requests: {}, completedRequests: {} };
    let version = 1;

    await updateSessionAgentStateWithAck({
      socket,
      sessionId: 's1',
      ownerActivityDelivery: 'rich_sender',
      sessionEncryptionMode: 'plain',
      getAgentState: () => agentState,
      setAgentState: (next) => {
        agentState = next;
      },
      getAgentStateVersion: () => version,
      setAgentStateVersion: (next) => {
        version = next;
      },
      syncSessionSnapshotFromServer: async () => {},
      handler: () => ({
        requests: {
          req_permission: {
            tool: 'Write',
            arguments: { path: '/tmp/a.ts' },
            createdAt: 1,
            turnId: 'turn_1',
          },
          req_action: {
            tool: 'AskUserQuestion',
            kind: 'user_action',
            arguments: { question: 'Ship it?' },
            createdAt: 2,
            turnId: 'turn_1',
          },
          req_completed: {
            tool: 'Write',
            arguments: { path: '/tmp/b.ts' },
            createdAt: 3,
          },
        },
        completedRequests: {
          req_completed: {
            tool: 'Write',
            arguments: { path: '/tmp/b.ts' },
            createdAt: 3,
            status: 'approved',
            completedAt: 4,
          },
        },
      }),
    });

    expect(agentState.requests.req_permission.tool).toBe('Write');
    expect(version).toBe(2);
  });

  it('does not send stale runtime issue summaries with update-state payloads', async () => {
    const runtimeIssueSummaryV1 = {
      latestTurnStatus: 'failed',
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1_778_089_800_000,
        provider: 'codex',
        sanitizedPreview: 'Usage limit reached',
      },
    } as const;
    const emitWithAck = vi.fn(async (_event: string, payload: any) => {
      expect(payload).not.toHaveProperty('runtimeIssueSummaryV1');
      return {
        result: 'success',
        agentState: payload.agentState,
        version: payload.expectedVersion + 1,
      };
    });

    let agentState: any = { requests: {}, completedRequests: {} };
    let version = 1;
    const updateWithStaleRuntimeIssueSummary = {
      socket: { emitWithAck },
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      getAgentState: () => agentState,
      setAgentState: (next) => {
        agentState = next;
      },
      getAgentStateVersion: () => version,
      setAgentStateVersion: (next) => {
        version = next;
      },
      syncSessionSnapshotFromServer: async () => {},
      handler: (current) => current,
      runtimeIssueSummaryV1,
    } satisfies Parameters<typeof updateSessionAgentStateWithAck>[0] & {
      runtimeIssueSummaryV1: typeof runtimeIssueSummaryV1;
    };

    await updateSessionAgentStateWithAck(updateWithStaleRuntimeIssueSummary);

    expect(version).toBe(2);
  });

  it('rejects metadata writes when the version remains unknown after snapshot sync', async () => {
    const socket = { emitWithAck: vi.fn() };
    let version = -1;

    await expect(updateSessionMetadataWithAck({
      socket,
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      getMetadata: () => null,
      setMetadata: () => {},
      getMetadataVersion: () => version,
      setMetadataVersion: (next) => {
        version = next;
      },
      syncSessionSnapshotFromServer: async () => {},
      handler: (current) => ({ ...current, path: '/tmp' }),
    })).rejects.toMatchObject({
      code: 'metadata_version_unknown',
      retryable: false,
    });

    expect(socket.emitWithAck).not.toHaveBeenCalled();
  });

  it('treats null metadata snapshots as empty objects once the version is known', async () => {
    const emitWithAck = vi.fn(async (_event: string, payload: PlainMetadataAckPayload) => ({
      result: 'success',
      metadata: payload.metadata,
      version: payload.expectedVersion + 1,
    }));

    let metadata: Metadata | null = null;
    let version = 1;

    await updateSessionMetadataWithAck({
      socket: { emitWithAck },
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      getMetadata: () => metadata,
      setMetadata: (next) => {
        metadata = next;
      },
      getMetadataVersion: () => version,
      setMetadataVersion: (next) => {
        version = next;
      },
      syncSessionSnapshotFromServer: async () => {},
      handler: (current) => createMetadata({ ...current, path: '/tmp' }),
    });

    expect(metadata).toEqual(createMetadata({ path: '/tmp' }));
    expect(version).toBe(2);
  });

});

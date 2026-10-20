import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { Credentials, StoredCredentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { buildTestCodexRuntimeDescriptorV1 as buildCodexAgentRuntimeDescriptor } from '@/testkit/runtimeDescriptorFixtures';
import { SessionWorkStateGetResponseV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';

const mocks = vi.hoisted(() => ({
  fetchAccountMachineReplacements: vi.fn(),
  callMachineRpc: vi.fn(),
  updateSessionMetadataWithRetry: vi.fn(async (params: {
    updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
  }) => ({
    version: 2,
    metadata: params.updater({ concurrent: 'preserved' }),
  })),
}));

vi.mock('@/session/transport/rpc/machineRpc', () => ({ callMachineRpc: mocks.callMachineRpc }));

vi.mock('@/api/machine/fetchAccountMachineReplacements', () => ({
  fetchAccountMachineReplacements: mocks.fetchAccountMachineReplacements,
}));

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry: mocks.updateSessionMetadataWithRetry,
}));

import { routeSessionGoalControl } from './sessionGoalControlRouter';

function createCredentials(): Credentials {
  return {
    token: 'token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(9),
    },
  };
}

function createTokenOnlyCredentials(): StoredCredentials {
  return {
    token: 'token',
    encryption: null,
  };
}

function createRawSession(overrides: Partial<RawSessionRecord> = {}): RawSessionRecord {
  return {
    id: 'sess_1',
    active: false,
    path: '/repo',
    machineId: 'machine-local',
    metadata: '{}',
    metadataVersion: 1,
    encryptionMode: 'plain',
    ...overrides,
  } as RawSessionRecord;
}

function createMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    machineId: 'machine-local',
    agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
      backendMode: 'appServer',
      providerSessionId: 'thread-1',
    }),
    ...overrides,
  };
}

const e2eeCtx = {
  encryptionKey: new Uint8Array(32).fill(1),
  encryptionVariant: 'legacy' as const,
};

describe('routeSessionGoalControl', () => {
  it('FIX75 stores and completes a configured ACP objective through the real daemon Goal owner', async () => {
    let metadata: Record<string, unknown> = {
      machineId: 'machine-local', path: '/repo',
      runtimeDescriptorV1: { v: 1, agentId: 'custom-acp', agent: { definitionId: 'configured-test' } },
      acpConfiguredBackendV1: { v: 1, updatedAt: 1, backendId: 'configured-test', title: 'Configured Agent' },
    };
    const route = (operation: 'get' | 'set' | 'clear', request?: { objective?: string; status?: 'complete' }) => routeSessionGoalControl({
      token: 'token', credentials: createTokenOnlyCredentials(), sessionId: 'sess_1',
      rawSession: createRawSession({ active: true }), metadata, currentMachineId: 'machine-local',
      ctx: null, mode: 'plain', operation, ...(request ? { request } : {}),
      callLiveSessionRpc: async () => ({ ok: false, errorCode: 'unsupported_session_runtime_method' }),
      stageWorkStateMutation: async mutation => {
        metadata = { ...metadata, sessionWorkStateV1: mutation.op.kind === 'set' ? mutation.op.value : null };
      },
    });
    await expect(route('set', { objective: 'Finish the work' })).resolves.toMatchObject({
      workState: { items: [expect.objectContaining({ kind: 'goal', origin: 'happier', title: 'Finish the work', status: 'active' })] },
    });
    await expect(route('get')).resolves.toMatchObject({ nativeGoalOwner: false,
      workState: { items: [expect.objectContaining({ title: 'Finish the work' })] } });
    // This is the exact consumer used by UI Goal operations, not a copied response DTO.
    expect(SessionWorkStateGetResponseV1Schema.parse(await route('get')).workState?.items[0]?.origin).toBe('happier');
    await expect(route('set', { status: 'complete' })).resolves.toMatchObject({
      workState: { items: [expect.objectContaining({ status: 'complete', completedAt: expect.any(Number) })] },
    });
    await expect(route('clear')).resolves.toMatchObject({ workState: { items: [] } });
  });

  it('FIX75 refuses a host Goal write without durable work-state wiring', async () => {
    await expect(routeSessionGoalControl({
      token: 'token', sessionId: 'sess_1', rawSession: createRawSession({ active: true }),
      metadata: { machineId: 'machine-local', path: '/repo' }, currentMachineId: 'machine-local',
      ctx: null, mode: 'plain', operation: 'set', request: { objective: 'Finish' },
      callLiveSessionRpc: async () => ({ ok: false, errorCode: 'unsupported_session_runtime_method' }),
    })).resolves.toMatchObject({ ok: false, errorCode: 'session_goal_control_work_state_custody_unavailable' });
  });

  beforeEach(() => {
    mocks.updateSessionMetadataWithRetry.mockClear();
    mocks.fetchAccountMachineReplacements.mockReset();
    mocks.callMachineRpc.mockReset();
    // The Account genuinely knows both machines and neither replaced the other,
    // so a refusal below is the guard deciding, not an empty chain.
    mocks.fetchAccountMachineReplacements.mockResolvedValue([
      { id: 'machine-local' },
      { id: 'machine-remote' },
    ]);
  });

  it('routes an inactive remote goal to its target daemon without opening local native state', async () => {
    const callMachineGoalRpc = vi.fn(async () => ({ workState: null }));
    const result = await routeSessionGoalControl({
      token: 'token', credentials: createTokenOnlyCredentials(), sessionId: 'sess_1',
      rawSession: createRawSession({ machineId: 'machine-remote' }),
      metadata: createMetadata({ machineId: 'machine-remote' }), currentMachineId: 'machine-local',
      ctx: null, mode: 'plain', operation: 'set', request: { status: 'paused' },
      callLiveSessionRpc: vi.fn(), callMachineGoalRpc,
    });
    expect(result).toEqual({ workState: null });
    expect(callMachineGoalRpc).toHaveBeenCalledWith({ machineId: 'machine-remote', operation: 'set',
      request: { status: 'paused' }, resumeInactiveWithInitialGoal: false });
  });

  it('refuses conflicting target identities and cancellation before any goal or wake effect', async () => {
    const callMachineGoalRpc = vi.fn();
    const base = { token: 'token', credentials: createTokenOnlyCredentials(), sessionId: 'sess_1',
      rawSession: createRawSession(), metadata: createMetadata({ machineId: 'machine-remote' }),
      currentMachineId: 'machine-local', ctx: null, mode: 'plain' as const, operation: 'set' as const,
      request: { objective: 'Finish' }, resumeInactiveWithInitialGoal: true, callLiveSessionRpc: vi.fn(), callMachineGoalRpc };
    await expect(routeSessionGoalControl(base)).resolves.toMatchObject({ ok: false,
      errorCode: 'session_goal_control_target_machine_mismatch' });
    const controller = new AbortController();
    controller.abort();
    await expect(routeSessionGoalControl({ ...base, metadata: createMetadata(), signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.callMachineRpc).not.toHaveBeenCalled();
    expect(callMachineGoalRpc).not.toHaveBeenCalled();
  });

  it('delegates inactive local set mutations and durably stages the work-state field', async () => {
    const rawSession = createRawSession({ path: '/home/coder/project' });
    const nextMetadata = {
      machineId: 'machine-local',
      sessionWorkStateV1: { v: 1, backendId: 'codex', items: [], primaryItemId: null, updatedAt: 1 },
    };
    const setGoal = vi.fn(async () => ({
      metadata: nextMetadata,
      workState: nextMetadata.sessionWorkStateV1,
    }));
    const resolveAdapter = vi.fn(async () => ({ setGoal }));
    const stageWorkStateMutation = vi.fn(async () => {});

    await expect(routeSessionGoalControl({
      token: 'token',
      credentials: createTokenOnlyCredentials(),
      sessionId: 'sess_1',
      rawSession,
      metadata: createMetadata({
        path: '/home/coder/project',
        sessionWorkspaceLocationV1: {
          v: 1,
          machineId: 'machine-local',
          agentPath: '/home/coder/project',
          machinePath: '/Users/alice/project',
        },
      }),
      currentMachineId: 'machine-local',
      ctx: null,
      mode: 'plain',
      operation: 'set',
      request: { status: 'paused' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter,
      stageWorkStateMutation,
    })).resolves.toMatchObject({
      metadata: expect.objectContaining({
        sessionWorkStateV1: nextMetadata.sessionWorkStateV1,
      }),
      workState: nextMetadata.sessionWorkStateV1,
    });

    expect(resolveAdapter).toHaveBeenCalledWith('codex');
    expect(setGoal).toHaveBeenCalledWith(expect.objectContaining({
      credentials: createTokenOnlyCredentials(),
      sessionId: 'sess_1',
      request: { status: 'paused' },
      cwd: '/Users/alice/project',
      ctx: null,
      mode: 'plain',
    }));
    expect(stageWorkStateMutation).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      fieldId: 'runtime.workState',
      source: 'daemon',
      op: { kind: 'set', value: nextMetadata.sessionWorkStateV1 },
    }), { signal: undefined });
    expect(mocks.updateSessionMetadataWithRetry).not.toHaveBeenCalled();
  });

  it('refuses an invalid inactive work-state projection before reporting goal success', async () => {
    const stageWorkStateMutation = vi.fn(async () => {});
    await expect(routeSessionGoalControl({
      token: 'token',
      credentials: createTokenOnlyCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession(),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx: null,
      mode: 'plain',
      operation: 'set',
      request: { status: 'paused' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ setGoal: vi.fn(async () => ({
        metadata: { sessionWorkStateV1: { v: 1, items: [], updatedAt: 1 } },
      })) })),
      stageWorkStateMutation,
    })).rejects.toThrow('invalid_daemon_work_state_mutation');
    expect(stageWorkStateMutation).not.toHaveBeenCalled();
  });

  // G-4: a transient live-RPC TRANSPORT failure on an ACTIVE session must NOT fall back to the
  // metadata adapter. Falling back would seed a decorative `status:'active'` goal the running
  // session never started pursuing (`/goal` never reached the provider) — a metadata↔runtime
  // split-brain. The typed transport error must surface to the caller instead.
  it('surfaces a transport-failure error on an active session WITHOUT seeding a metadata goal', async () => {
    const transportError = { ok: false, errorCode: 'session_rpc_failed', error: 'session_rpc_failed' };
    const callLiveSessionRpc = vi.fn(async () => transportError);
    const resolveAdapter = vi.fn(async () => ({ setGoal: vi.fn() }));

    await expect(routeSessionGoalControl({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({ active: true }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx: e2eeCtx,
      mode: 'e2ee',
      operation: 'set',
      request: { status: 'paused' },
      callLiveSessionRpc,
      resolveAdapter,
    })).resolves.toEqual(transportError);

    expect(callLiveSessionRpc).toHaveBeenCalledTimes(1);
    expect(resolveAdapter).not.toHaveBeenCalled();
    expect(mocks.updateSessionMetadataWithRetry).not.toHaveBeenCalled();
  });

  // A DEFINITIVE capability signal (the runtime genuinely cannot serve the method) still falls back
  // to the inactive metadata adapter — only transport failures are excluded (G-4).
  it('still falls back to the adapter on an active session when the runtime cannot serve the method', async () => {
    const nextMetadata = {
      machineId: 'machine-local',
      sessionWorkStateV1: { v: 1, backendId: 'codex', items: [], primaryItemId: null, updatedAt: 1 },
    };
    const setGoal = vi.fn(async () => ({
      metadata: nextMetadata,
      workState: nextMetadata.sessionWorkStateV1,
    }));
    const resolveAdapter = vi.fn(async () => ({ setGoal }));

    await expect(routeSessionGoalControl({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({ active: true }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx: e2eeCtx,
      mode: 'e2ee',
      operation: 'set',
      request: { status: 'paused' },
      callLiveSessionRpc: vi.fn(async () => ({
        ok: false,
        errorCode: 'unsupported_session_runtime_method',
        error: 'unsupported_session_runtime_method',
      })),
      resolveAdapter,
      stageWorkStateMutation: vi.fn(async () => {}),
    })).resolves.toMatchObject({
      metadata: expect.objectContaining({
        sessionWorkStateV1: nextMetadata.sessionWorkStateV1,
      }),
    });

    expect(resolveAdapter).toHaveBeenCalledWith('codex');
    expect(setGoal).toHaveBeenCalled();
    // Cost discipline: the common path never reads the Account machine chain.
    expect(mocks.fetchAccountMachineReplacements).not.toHaveBeenCalled();
  });

  it('does not delegate or persist remote inactive goal controls', async () => {
    const resolveAdapter = vi.fn(async () => ({ setGoal: vi.fn() }));

    await expect(routeSessionGoalControl({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({ machineId: 'machine-remote' }),
      metadata: createMetadata({ machineId: 'machine-remote' }),
      currentMachineId: 'machine-local',
      ctx: e2eeCtx,
      mode: 'e2ee',
      operation: 'set',
      request: { status: 'paused' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'session_goal_control_remote_unavailable',
      error: 'session_goal_control_remote_unavailable',
    });

    expect(resolveAdapter).not.toHaveBeenCalled();
    expect(mocks.updateSessionMetadataWithRetry).not.toHaveBeenCalled();
  });

  it('delegates inactive goal controls from a stale machine id when the current daemon proves same host and home', async () => {
    const nextWorkState = { v: 1, backendId: 'codex', items: [], primaryItemId: null, updatedAt: 11 };
    const setGoal = vi.fn(async () => ({
      metadata: createMetadata({
        machineId: 'machine-before-restart',
        sessionWorkStateV1: nextWorkState,
      }),
      workState: nextWorkState,
    }));
    const resolveAdapter = vi.fn(async () => ({ setGoal }));

    await expect(routeSessionGoalControl({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_stale_goal',
      rawSession: createRawSession({
        id: 'sess_stale_goal',
        machineId: 'machine-before-restart',
      }),
      metadata: createMetadata({
        machineId: 'machine-before-restart',
        host: 'LEEROY-MBP.local',
        homeDir: 'C:\\Users\\Leeroy\\',
      }),
      currentMachineId: 'machine-after-restart',
      currentMachineHost: 'leeroy-mbp',
      currentMachineHomeDir: 'c:/users/leeroy',
      ctx: e2eeCtx,
      mode: 'e2ee',
      operation: 'set',
      request: { status: 'paused' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter,
      stageWorkStateMutation: vi.fn(async () => {}),
    })).resolves.toMatchObject({
      metadata: expect.objectContaining({
        sessionWorkStateV1: nextWorkState,
      }),
      workState: nextWorkState,
    });

    expect(resolveAdapter).toHaveBeenCalledWith('codex');
    expect(setGoal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_stale_goal',
      currentMachineId: 'machine-after-restart',
      sessionMachineId: 'machine-before-restart',
    }));
  });
  /**
   * The user's ruling: replacing a machine must not strand the Sessions the
   * previous one hosted. Nothing re-homes a Session row, so its recorded host
   * stays the PREDECESSOR forever, and the client already picks this daemon as
   * the RPC target by walking the same replacement chain. A replacement is a
   * genuinely new host, so it cannot earn the same-host-home proof.
   */
  it('delegates inactive goal controls for a session whose recorded machine this one replaced', async () => {
    mocks.fetchAccountMachineReplacements.mockResolvedValue([
      { id: 'machine-old', replacedByMachineId: 'machine-new' },
      { id: 'machine-new' },
    ]);
    const nextWorkState = { v: 1, backendId: 'codex', items: [], primaryItemId: null, updatedAt: 12 };
    const setGoal = vi.fn(async () => ({
      metadata: createMetadata({ machineId: 'machine-old', sessionWorkStateV1: nextWorkState }),
      workState: nextWorkState,
    }));
    const resolveAdapter = vi.fn(async () => ({ setGoal }));

    await expect(routeSessionGoalControl({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_replaced_goal',
      rawSession: createRawSession({ id: 'sess_replaced_goal', machineId: 'machine-old' }),
      metadata: createMetadata({ machineId: 'machine-old', host: 'old-laptop', homeDir: '/Users/leeroy' }),
      currentMachineId: 'machine-new',
      currentMachineHost: 'new-laptop',
      currentMachineHomeDir: '/Users/leeroy',
      ctx: e2eeCtx,
      mode: 'e2ee',
      operation: 'set',
      request: { status: 'paused' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter,
      stageWorkStateMutation: vi.fn(async () => {}),
    })).resolves.toMatchObject({ workState: nextWorkState });

    expect(setGoal).toHaveBeenCalledWith(expect.objectContaining({
      currentMachineId: 'machine-new',
      sessionMachineId: 'machine-old',
    }));
  });

  it('still refuses inactive goal controls when the replacement chain is unreadable', async () => {
    mocks.fetchAccountMachineReplacements.mockResolvedValue(null);
    const resolveAdapter = vi.fn(async () => ({ setGoal: vi.fn() }));

    await expect(routeSessionGoalControl({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({ machineId: 'machine-old' }),
      metadata: createMetadata({ machineId: 'machine-old' }),
      currentMachineId: 'machine-new',
      ctx: e2eeCtx,
      mode: 'e2ee',
      operation: 'set',
      request: { status: 'paused' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'session_goal_control_remote_unavailable',
      error: 'session_goal_control_remote_unavailable',
    });

    expect(resolveAdapter).not.toHaveBeenCalled();
  });
});

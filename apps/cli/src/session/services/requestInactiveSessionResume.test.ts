import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import {
  deriveSessionCreationTagV1,
  SessionCreationCorrespondenceV1Schema,
} from '@happier-dev/protocol';

const { callMachineRpc } = vi.hoisted(() => ({ callMachineRpc: vi.fn() }));
vi.mock('@/session/transport/rpc/machineRpc', () => ({ callMachineRpc }));

import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { requestInactiveSessionResume } from './requestInactiveSessionResume';
import { logger } from '@/ui/logger';

const machineKey = new Uint8Array(32).fill(1);
const credentials = {
  token: 'account-token',
  encryption: { type: 'dataKey' as const, publicKey: machineKey, machineKey },
};

function rawSession(overrides: Record<string, unknown> = {}): RawSessionRecord {
  return {
    id: 'session-1', active: false, machineId: 'machine-1', path: '/repo', seq: 17, ...overrides,
  } as unknown as RawSessionRecord;
}

const metadata = {
  machineId: 'machine-1',
  path: '/repo',
  runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
  claudeSessionId: 'provider-session-1',
};

const providerMetadata = {
  ...metadata,
  providerBindingV1: {
    v: 1,
    connectionId: 'pc_work',
    contributionKey: 'plugin.gateway/gateway',
    connectionRevision: 2,
    protocol: 'openai-responses',
    materialization: 'engineConfig',
    adapterBindingKey: 'gateway',
    compatibilityFingerprint: 'compatibility-v1',
    bindingSecurityFingerprint: 'security-v1',
    displaySnapshot: {
      providerName: 'Gateway',
      connectionName: 'Work',
      connectionRole: 'named',
      connectionDisplayNameMode: 'custom',
    },
  },
  modelSelectionIntentV1: {
    v: 1,
    updatedAt: 100,
    selection: {
      agentTargetKey: 'agent:happier.agent.claude/claude',
      providerConnectionId: 'pc_work',
      modelId: 'provider-model',
    },
  },
} as const;

function metadataWithLaunchCorrespondence() {
  const sessionCreationTag = deriveSessionCreationTagV1({
    callerCreationNamespace: 'user',
    creationKey: 'creation-resume-rpc',
  });
  const correspondence = SessionCreationCorrespondenceV1Schema.parse({
    v: 1,
    sessionCreationTag,
    recipe: {
      execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/repo' } },
      organization: { folderId: null, tagIds: [] },
      agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
      },
      modelSelection: null,
      profileId: 'profile-shared',
      secretReferenceOverlay: {
        v: 1,
        bindings: {
          ANTHROPIC_API_KEY: {
            ref: 'happier:shared-secret:v1:shared-anthropic',
            revision: 5,
          },
        },
      },
      requestedPermissionMode: null,
      agentModeId: null,
      configuration: null,
      connectedServices: null,
      capabilitySelection: null,
      transcriptStorage: null,
      terminal: null,
      agentSessionStartupInstructionsMarkerV1: null,
      checkout: null,
    },
  });
  return {
    correspondence,
    metadata: { ...metadata, sessionCreationCorrespondenceV1: correspondence },
  };
}

describe('requestInactiveSessionResume', () => {
  it('delivers the invocation initial goal in the existing resume request without changing saved launch controls', async () => {
    callMachineRpc.mockResolvedValue({ type: 'success', sessionId: 'session-1' });
    await expect(requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'goal-request',
      rawSession: rawSession(), metadata, initialGoal: { objective: 'Finish the task', tokenBudget: null },
    })).resolves.toEqual({ ok: true });
    expect(callMachineRpc.mock.calls[0]?.[0]?.request).toMatchObject({
      type: 'resume-session', sessionId: 'session-1',
      initialGoal: { objective: 'Finish the task', tokenBudget: null }, initialTranscriptAfterSeq: 17,
    });
  });
  it('does not fabricate a fresh user-message authorization for an automated goal wake', async () => {
    callMachineRpc.mockResolvedValue({ type: 'success', sessionId: 'session-1' });
    await expect(requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'goal-request',
      rawSession: rawSession(), metadata, initialGoal: { objective: 'Finish the task' },
      executionAuthority: 'account_automation',
    })).resolves.toEqual({ ok: true });
    expect(callMachineRpc.mock.calls[0]?.[0]?.request).not.toHaveProperty('executionAuthorization');
  });
  it.each([100, 200, 300])('resumes with predecessor launch intent and timestamp-selected controls (%s)', async (incomingAt) => {
    callMachineRpc.mockResolvedValue({ type: 'success', sessionId: 'session-1' });
    const modelRef = (modelId: string) => ({ agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId });
    const request = {
      credentials, sessionId: 'session-1', localId: 'workflow-input', rawSession: rawSession(),
      metadata: { ...metadata, permissionMode: 'read-only', permissionModeUpdatedAt: 200,
        modelSelectionIntentV1: { v: 1, updatedAt: 200, selection: modelRef('saved-model') } },
      incomingOptions: { permissionMode: 'default' as const, permissionModeUpdatedAt: incomingAt,
        modelSelection: { v: 1 as const, updatedAt: incomingAt, ref: modelRef('incoming-model') },
        environmentVariables: { PREDECESSOR_RUN: 'literal value' }, resume: 'incoming-native-session',
      },
    };
    await expect(requestInactiveSessionResume(request)).resolves.toEqual({ ok: true });
    expect(callMachineRpc.mock.calls[0]?.[0]?.request).toMatchObject({
      type: 'resume-session', sessionId: 'session-1', resume: 'incoming-native-session',
      environmentVariables: { PREDECESSOR_RUN: 'literal value' },
      permissionMode: incomingAt < 200 ? 'read-only' : 'default',
      permissionModeUpdatedAt: Math.max(incomingAt, 200),
      modelSelection: { ref: { modelId: incomingAt < 200 ? 'saved-model' : 'incoming-model' }, updatedAt: Math.max(incomingAt, 200) },
    });
  });

  it('resumes with the predecessor explicit offline launch family while retaining canonical Session identity', async () => {
    callMachineRpc.mockResolvedValue({ type: 'success', sessionId: 'session-1' });
    const request = { credentials, sessionId: 'session-1', localId: 'workflow-launch', rawSession: rawSession(),
      metadata: metadataWithLaunchCorrespondence().metadata,
      incomingOptions: { profileId: 'incoming-profile', terminal: { mode: 'plain' as const },
        windowsRemoteSessionLaunchMode: 'windows_terminal' as const, windowsTerminalWindowName: 'Incoming window',
        agentModeId: 'incoming-mode', transcriptStorage: 'persisted' as const,
        connectedServices: { v: 2 as const, bindingsByServiceId: {} },
        capabilitySelection: { mcp: { v: 1 as const, managedServersEnabled: false, forceIncludeServerIds: [], forceExcludeServerIds: [] } },
      } };
    await expect(requestInactiveSessionResume(request)).resolves.toEqual({ ok: true });
    expect(callMachineRpc.mock.calls[0]?.[0]?.request).toMatchObject({ type: 'resume-session', sessionId: 'session-1', directory: '/repo',
      profileId: 'incoming-profile', terminal: { mode: 'plain' }, windowsRemoteSessionLaunchMode: 'windows_terminal',
      windowsTerminalWindowName: 'Incoming window', agentModeId: 'incoming-mode', transcriptStorage: 'persisted',
      connectedServices: { v: 2, bindingsByServiceId: {} },
      capabilitySelection: { mcp: { v: 1, managedServersEnabled: false, forceIncludeServerIds: [], forceExcludeServerIds: [] } },
    });
  });

  it('applies an explicit same-Agent driver choice while retaining the Session native recovery identity', async () => {
    callMachineRpc.mockResolvedValue({ type: 'success', sessionId: 'session-1' });
    await expect(requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'workflow-driver', rawSession: rawSession(),
      metadata: { ...metadata, runtimeDescriptorV1: { v: 1, agentId: 'codex',
        agent: { backendMode: 'appServer', providerSessionId: 'existing-native', appServerEndpoint: '/native/socket' } },
        claudeSessionId: undefined, codexSessionId: 'existing-native' },
      incomingOptions: { runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'acp' } } },
    })).resolves.toEqual({ ok: true });
    expect(callMachineRpc.mock.calls[0]?.[0]?.request).toMatchObject({ type: 'resume-session', sessionId: 'session-1',
      runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'acp', providerSessionId: 'existing-native', appServerEndpoint: '/native/socket' } },
    });
  });

  it('refuses an authored driver descriptor that changes the existing Session Agent', async () => {
    await expect(requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'workflow-wrong-agent', rawSession: rawSession(), metadata,
      incomingOptions: { runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'acp' } } },
    })).resolves.toMatchObject({ ok: false, code: 'unsupported' });
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('sends explicit fresh-folder consent without granting automatic managed-folder recreation', async () => {
    callMachineRpc.mockResolvedValue({ type: 'success' });
    const request = {
      credentials, sessionId: 'session-1', localId: 'fresh-folder-1', rawSession: rawSession(),
      metadata: { ...metadata, sessionDirectoryV1: { v: 1, kind: 'managed' } },
      approvedNewDirectoryCreation: true,
    };
    await expect(requestInactiveSessionResume(request)).resolves.toEqual({ ok: true });
    expect(callMachineRpc.mock.calls[0]?.[0]?.request).toMatchObject({ approvedNewDirectoryCreation: true });
    callMachineRpc.mockClear();
    const { approvedNewDirectoryCreation: _consent, ...withoutConsent } = request;
    await requestInactiveSessionResume(withoutConsent);
    expect(callMachineRpc.mock.calls[0]?.[0]?.request.approvedNewDirectoryCreation).not.toBe(true);
  });

  it('preserves the missing-directory recovery outcome', async () => {
    callMachineRpc.mockResolvedValue({ type: 'error', errorCode: 'SESSION_DIRECTORY_MISSING', errorMessage: 'Missing folder' });
    await expect(requestInactiveSessionResume({
      credentials, sessionId: 'session-1', localId: 'local-1', rawSession: rawSession(),
      metadata: { ...metadata, sessionDirectoryV1: { v: 1, kind: 'managed' } },
    })).resolves.toMatchObject({ ok: false, code: 'SESSION_DIRECTORY_MISSING' });
  });

  afterEach(() => {
    callMachineRpc.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('accepts the canonical resume success response while sending identity-only execution authorization', async () => {
    callMachineRpc.mockResolvedValue({ type: 'success' });

    await expect(requestInactiveSessionResume({
      credentials, sessionId: 'session-1', localId: 'local-1', rawSession: rawSession(), metadata,
    })).resolves.toEqual({ ok: true });

    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      request: expect.objectContaining({
        type: 'resume-session',
        sessionId: 'session-1',
        executionAuthorization: { provenance: 'user_request', requestId: 'local-1' },
      }),
    }));
    expect(callMachineRpc).toHaveBeenCalledTimes(1);
    expect(callMachineRpc.mock.calls[0]?.[0]?.request).not.toHaveProperty('spawnNonce');
    expect(callMachineRpc.mock.calls[0]?.[0]?.request).not.toHaveProperty('agentRuntimeDescriptorV1');
    expect(callMachineRpc.mock.calls[0]?.[0]?.request).not.toHaveProperty('codexBackendMode');
  });

  it('carries immutable launch profile and Saved Secret references through the resume RPC', async () => {
    callMachineRpc.mockResolvedValue({ type: 'success' });
    const persisted = metadataWithLaunchCorrespondence();

    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession(),
      metadata: persisted.metadata,
    })).resolves.toEqual({ ok: true });

    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        sessionCreationTag: persisted.correspondence.sessionCreationTag,
        sessionCreationCorrespondence: persisted.correspondence,
        profileId: 'profile-shared',
        secretReferenceOverlay: persisted.correspondence.recipe.secretReferenceOverlay,
      }),
    }));
  });

  it('refuses an externally linked inactive session before spawn so takeover owns hosted admission', async () => {
    // An externally linked Session's hosted runtime is owned by the External
    // Sessions takeover operation. Automatic resume must not spawn it.
    const linkedMetadata = {
      ...metadata,
      externalSessionV1: {
        v: 1,
        agentId: 'claude',
        machineId: 'machine-1',
        remoteSessionId: 'vendor-session-1',
        source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
        linkedAtMs: 1_000,
      },
    };

    await expect(requestInactiveSessionResume({
      credentials, sessionId: 'session-1', localId: 'local-1', rawSession: rawSession(), metadata: linkedMetadata,
    })).resolves.toMatchObject({ ok: false, code: 'takeover_required' });

    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('refuses an inactive session whose external link exists but is unresolved instead of spawning it', async () => {
    // A link that cannot be trusted is not absence of a link: fail closed.
    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession(),
      metadata: { ...metadata, externalSessionV1: { v: 1 } },
    })).resolves.toMatchObject({ ok: false, code: 'takeover_required' });

    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('rejects an archived session before contacting its recorded machine', async () => {
    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession({ archivedAt: 123 }),
      metadata,
    })).resolves.toEqual({
      ok: false,
      code: 'session_archived',
      message: 'Archived sessions must be unarchived before resume',
    });

    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('accepts an already-running runner without waiting for an unadmitted resume nonce', async () => {
    callMachineRpc.mockImplementation(async ({ method }: { method: string }) => method === RPC_METHODS.SPAWN_HAPPY_SESSION
      ? { type: 'success', sessionId: 'session-1' }
      : { status: 'not_found' });
    await expect(requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'local-1',
      rawSession: rawSession(), metadata, waitForReady: true })).resolves.toEqual({ ok: true });
  });

  it('waits for a 1231ms accepted resume to become ready without submitting the resume twice', async () => {
    vi.useFakeTimers();
    vi.stubEnv('HAPPIER_SPAWN_SESSION_ID_RESOLVE_TIMEOUT_MS', '5000');
    callMachineRpc.mockImplementation(async (params: Readonly<{ method: string }>) => {
      if (params.method === RPC_METHODS.SPAWN_HAPPY_SESSION) {
        return {
          type: 'success',
          sessionId: 'session-1',
          spawnNonce: 'spawn-nonce-1',
        };
      }
      if (
        params.method === RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE
        || params.method === RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1231));
        return { status: 'success', sessionId: 'session-1' };
      }
      throw new Error(`Unexpected machine RPC method: ${params.method}`);
    });
    let settled = false;
    const input = {
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession(),
      metadata,
      waitForReady: true,
    } as const;

    const result = requestInactiveSessionResume(input).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(1230);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(20);

    await expect(result).resolves.toEqual({ ok: true });
    expect(callMachineRpc.mock.calls.filter(([params]) => params.method === RPC_METHODS.SPAWN_HAPPY_SESSION)).toHaveLength(1);
    expect(callMachineRpc.mock.calls.filter(([params]) => params.method === RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE)).toHaveLength(1);
    expect(callMachineRpc.mock.calls.filter(([params]) => params.method === RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE)).toHaveLength(0);
    expect(callMachineRpc.mock.calls[0]?.[0]?.request).toMatchObject({
      spawnNonce: expect.stringMatching(/^inactive-session\.resume:/u),
    });
  });

  it('fails closed on conflicting machine identity without issuing a resume', async () => {
    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession({ machineId: 'machine-other' }),
      metadata,
    })).resolves.toMatchObject({ ok: false, code: 'unsupported' });
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('rejects a success response that explicitly names a different session', async () => {
    callMachineRpc.mockResolvedValue({ type: 'success', sessionId: 'session-other' });

    await expect(requestInactiveSessionResume({
      credentials, sessionId: 'session-1', localId: 'local-1', rawSession: rawSession(), metadata,
    })).resolves.toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('reports a machine that failed the resume as a failure, not as an unsupported capability', async () => {
    // The observed defect: a filesystem error from the machine's own resume
    // work came back as `unsupported`, which reads as "this Session can never
    // be resumed" and shapes the recovery the caller offers. The machine tried
    // and failed; retrying it is exactly the right next move.
    callMachineRpc.mockResolvedValue({
      type: 'error',
      errorMessage: "Connected services resolution failed: ENOTEMPTY: directory not empty, rmdir '/tmp/cs'",
    });

    await expect(requestInactiveSessionResume({
      credentials, sessionId: 'session-1', localId: 'local-1', rawSession: rawSession(), metadata,
    })).resolves.toMatchObject({ ok: false, code: 'resume_failed' });
  });

  it('reports a machine that threw during the resume as a failure, not as an unsupported capability', async () => {
    callMachineRpc.mockRejectedValue(new Error('socket closed'));

    await expect(requestInactiveSessionResume({
      credentials, sessionId: 'session-1', localId: 'local-1', rawSession: rawSession(), metadata,
    })).resolves.toMatchObject({ ok: false, code: 'resume_failed' });
  });

  it('uses one current-only Provider-safe RPC so an older daemon refuses inactive wake before side effects', async () => {
    // A daemon that does not carry the method at all IS a capability statement,
    // and it is the only failure here that is.
    callMachineRpc.mockRejectedValueOnce(new RpcError('method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE));

    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession(),
      metadata: providerMetadata,
    })).resolves.toMatchObject({ ok: false, code: 'unsupported' });

    expect(callMachineRpc).toHaveBeenCalledTimes(1);
    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    }));
    expect(callMachineRpc).not.toHaveBeenCalledWith(expect.objectContaining({
      method: RPC_METHODS.SPAWN_HAPPY_SESSION,
    }));
  });

  it('wakes a Provider-bound inactive session through the atomic Provider-safe RPC', async () => {
    callMachineRpc.mockResolvedValueOnce({ type: 'success' });

    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession(),
      metadata: providerMetadata,
    })).resolves.toEqual({ ok: true });

    expect(callMachineRpc).toHaveBeenCalledTimes(1);
    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    }));
  });

  it('retains custody when resume times out', async () => {
    const diagnostic = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    callMachineRpc.mockRejectedValue(Object.assign(new Error('timed out'), { code: 'MACHINE_RPC_TIMEOUT' }));

    await expect(requestInactiveSessionResume({
      credentials, sessionId: 'session-1', localId: 'local-1', rawSession: rawSession(), metadata,
    })).resolves.toMatchObject({ ok: false, code: 'timeout' });
    expect(diagnostic).toHaveBeenCalledWith('[SessionResume] Readiness refused', expect.objectContaining({
      requestId: 'local-1', sessionId: 'session-1', machineId: 'machine-1',
      phase: 'spawn_rpc', cause: 'MACHINE_RPC_TIMEOUT', outcomeCode: 'timeout',
      spawnRpcRequestId: callMachineRpc.mock.calls[0]?.[0]?.requestId,
      transport: 'machine_rpc',
      elapsedMs: expect.any(Number), cancelled: false,
    }));
  });

  it('distinguishes an accepted launch readiness timeout from the initial RPC timeout', async () => {
    const diagnostic = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    callMachineRpc.mockResolvedValueOnce({ type: 'success', spawnNonce: 'accepted-launch' });
    callMachineRpc.mockResolvedValueOnce({ status: 'error', errorCode: 'SESSION_WEBHOOK_TIMEOUT', errorMessage: 'private native detail' });
    await expect(requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'local-1',
      rawSession: rawSession(), metadata, waitForReady: true })).resolves.toMatchObject({ ok: false, code: 'timeout' });
    expect(diagnostic).toHaveBeenCalledWith('[SessionResume] Readiness refused', expect.objectContaining({
      phase: 'nonce_readiness', cause: 'SESSION_WEBHOOK_TIMEOUT', outcomeCode: 'timeout',
    }));
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private native detail');
  });

  it('does not log arbitrary transport codes or error prose in readiness diagnostics', async () => {
    const diagnostic = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    callMachineRpc.mockRejectedValue(Object.assign(new Error('private transport detail'), { code: 'private-code' }));
    await expect(requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'local-1',
      rawSession: rawSession(), metadata })).resolves.toMatchObject({ ok: false, code: 'resume_failed' });
    expect(diagnostic).toHaveBeenCalledWith('[SessionResume] Readiness refused', expect.objectContaining({
      phase: 'spawn_rpc', cause: 'unclassified', outcomeCode: 'resume_failed',
    }));
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/private transport detail|private-code|account-token/);
  });

  it('identifies caller cancellation without logging the abort reason', async () => {
    const diagnostic = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const cancellation = new AbortController();
    callMachineRpc.mockImplementationOnce(async () => {
      cancellation.abort(new Error('private abort reason'));
      throw cancellation.signal.reason;
    });
    await expect(requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'local-1',
      rawSession: rawSession(), metadata, signal: cancellation.signal })).resolves.toMatchObject({ ok: false, code: 'resume_failed' });
    expect(diagnostic).toHaveBeenCalledWith('[SessionResume] Readiness refused', expect.objectContaining({
      phase: 'spawn_rpc', cancelled: true, cause: 'unclassified', outcomeCode: 'resume_failed',
    }));
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private abort reason');
  });
});

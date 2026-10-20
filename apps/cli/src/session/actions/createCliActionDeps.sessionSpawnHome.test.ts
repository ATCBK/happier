import { tmpdir } from 'node:os';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerSessionCreationTargetPreparationRpc } from '@/session/creation/registerSessionCreationTargetPreparationRpc';
import { createCliActionDeps } from './createCliActionDeps';

describe('Session spawn Home admission', () => {
  afterEach(() => vi.restoreAllMocks());
  it('admits a portable Home identity through the registered target preparation and refuses another Home', async () => {
    const rpc = new RpcHandlerManager({ scopePrefix: 'target-machine', encryptionMode: 'plain', logger() {} });
    registerSessionCreationTargetPreparationRpc({ rpcHandlerManager: rpc });
    const lifetime = new AbortController();
    const input = SessionSpawnNewInputV2Schema.parse({
      creationKey: 'channel-thread:router:thread',
      executionTarget: { serverId: 'portable-home', machineId: 'target-machine' },
      directory: { kind: 'path', path: tmpdir() },
      agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'worker' } },
      attestedContext: { externalPrincipalId: 'principal-1', sourceMessageId: 'message-1' },
    });
    const deps = createCliActionDeps({
      token: 'fixture-token', credentials: { token: 'fixture-token', encryption: null },
      sessionId: '', mode: 'plain', ctx: null,
      serverId: 'local-profile', serverIdentityId: 'portable-home', serverHttpBaseUrl: 'https://home.test',
      // Substitute only Machine RPC transport. Registration, request parsing,
      // target filesystem preparation and the CLI admission owner remain real.
      machineActionDirectTargetTransport: { machineId: 'target-machine', invoke: (method, request, options) =>
        rpc.invokeLocal(method, request, { signal: options?.signal }) },
    });
    const preflight = deps.sessionSpawnNewDirectoryApprovalPreflight;
    if (!preflight) throw new Error('Missing Session directory preflight');
    await expect(preflight({ input, signal: lifetime.signal })).resolves.toEqual({ type: 'not_required' });
    await expect(preflight({ input: { ...input, executionTarget: { ...input.executionTarget, serverId: 'local-profile' } },
      signal: lifetime.signal })).resolves.toEqual({ type: 'not_required' });
    await expect(preflight({ input: { ...input, executionTarget: { ...input.executionTarget, serverId: 'other-home' } },
      signal: lifetime.signal })).resolves.toEqual({ type: 'error',
      result: { type: 'error', code: 'target_unavailable', retryable: false } });

    // Home admission must also reach the actual spawn owner's capability gate.
    // A Home HTTP absence is a genuine boundary refusal; no native Session is created.
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 404, data: {} });
    const spawnInput = { ...input,
      sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'plugin:acme.channels', creationKey: input.creationKey }),
      actionCaller: { kind: 'plugin' as const, pluginId: 'acme.channels' }, signal: lifetime.signal };
    await expect(deps.sessionSpawnNew(spawnInput)).resolves.toMatchObject({
      type: 'error', code: 'incompatible_target', retryable: false,
      incompatibleTarget: { reason: 'session_spawn_protocol_unavailable' },
    });
    await expect(deps.sessionSpawnNew({ ...spawnInput,
      executionTarget: { ...input.executionTarget, serverId: 'other-home' } })).resolves.toEqual({
      type: 'error', code: 'target_unavailable', retryable: false,
    });

    // A disconnected registration must not pass on Home equality alone.
    rpc.unregisterHandler(RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT);
    await expect(preflight({ input, signal: lifetime.signal })).resolves.toEqual({ type: 'error', result: {
      type: 'error', code: 'incompatible_target', retryable: false,
      incompatibleTarget: { reason: 'target_preparation_invalid_result' },
    } });
  });
});

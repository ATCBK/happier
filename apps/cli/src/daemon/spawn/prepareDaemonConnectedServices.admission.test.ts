import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '@/api/api';
import { SpawnDaemonSessionRequestSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import { ForegroundAgentRuntimeAdmissionRequestV1Schema } from '@/daemon/agentRuntime/foregroundAdmissionContract';

import { prepareDaemonConnectedServices } from './prepareDaemonConnectedServices';

const malformedBindings = {
  v: 1,
  bindingsByServiceId: {
    'happier.agent.codex/openai-codex': {
      source: 'connected', selection: 'group', groupId: '../invalid', profileId: 'work',
    },
  },
};

describe('connected-account spawn admission', () => {
  it('uses the same binding admission for foreground launches', () => {
    const request = {
      v: 1, attemptId: 'attempt', sessionId: 'session', foregroundPid: 123,
      directory: '/synthetic/workspace', agentId: 'codex',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
    };
    expect(ForegroundAgentRuntimeAdmissionRequestV1Schema.safeParse({
      ...request, connectedServices: malformedBindings,
    }).success).toBe(false);
    const connectedServices = { v: 1, bindingsByServiceId: {
      'openai-codex': { source: 'connected', profileId: 'work' },
    } };
    expect(ForegroundAgentRuntimeAdmissionRequestV1Schema.parse({
      ...request, connectedServices,
    }).connectedServices).toEqual(SpawnDaemonSessionRequestSchema.parse({
      directory: request.directory, connectedServices,
    }).connectedServices);
  });

  async function prepare(connectedServices: unknown, existingSessionId = '') {
    const credentials = { token: 'synthetic-admission-test', encryption: null };
    const apiAccess = vi.fn(() => {
      throw new Error('Credential and network API must not be reached');
    });
    // This API boundary must be wholly unused; the proxy rejects every access, including credential reads.
    const api = new Proxy({} as ApiClient, { get: apiAccess });
    const repair = vi.fn(async () => null);
    const result = await prepareDaemonConnectedServices({
      options: {
        directory: '/synthetic/workspace', connectedServices,
        get connectedServiceMaterializationIdentityV1() {
          if (connectedServices === malformedBindings) throw new Error('Identity must not be read before admission');
          return undefined;
        },
      },
      normalizedExistingSessionId: existingSessionId,
      requestedSessionId: 'synthetic-session',
      effectiveResume: '',
      catalogAgentId: 'codex',
      credentials,
      api,
      qualifiedConnectedAccountApi: { listAccounts: apiAccess, readGroup: apiAccess },
      connectedServiceRefreshCoordinator: null,
      processEnv: {},
      connectedServicesMaterializationBaseDir: '/synthetic/materialization',
      pluginRuntimeRegistry: { contributes: { agentDefinitionsById: new Map() } },
      repairMissingMaterializationIdentity: repair,
    });
    expect(apiAccess).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
    return result;
  }

  it.each(['', 'existing-session'])('refuses malformed intent before fresh/resume materialization (%s)', async (existingSessionId) => {
    expect(await prepare(malformedBindings, existingSessionId)).toEqual({
      ok: false,
      result: {
        type: 'error',
        errorCode: 'SPAWN_VALIDATION_FAILED',
        errorMessage: 'connected_service_bindings_invalid',
      },
    });
  });

  it('refuses an unsupported Connected Account at qualified-purpose admission before credential access', async () => {
    expect(await prepare({ v: 2, bindingsByServiceId: {
      'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'profile', profileId: 'unsupported-profile' },
    } })).toMatchObject({ ok: false, result: { type: 'error', errorCode: 'SPAWN_VALIDATION_FAILED',
      errorDetail: { kind: 'launch_error', code: 'connected_service_qualified_purpose_authority_unavailable' } } });
  });

  it.each([
    undefined,
    { v: 1, bindingsByServiceId: {} },
    { v: 1, bindingsByServiceId: { 'happier.agent.codex/openai-codex': { source: 'native' } } },
    { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'native' } } },
  ])('keeps absent and native ingress free of connected authentication (%j)', async (connectedServices) => {
    const admitted = SpawnDaemonSessionRequestSchema.parse({ directory: '/synthetic/workspace', connectedServices });
    expect(await prepare(admitted.connectedServices)).toMatchObject({
      ok: true, auth: null, materializationIdentity: null,
    });
  });
});

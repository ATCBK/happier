import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  createSessionOwnerMetadataV1,
  projectSessionSharedMetadataV1,
} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { captureSessionLaunchControlMetadata, createSessionMetadata } from '@/agent/runtime/createSessionMetadata';
import { HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY } from '@/agent/runtime/sessionConnectedServicesBindingsEnv';
import { HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY } from '@/agent/runtime/sessionConnectedServiceMaterializationIdentityEnv';
import { buildInactiveSessionResumeSpawnOptions } from '@/daemon/sessions/runtimeSnapshot/buildInactiveSessionResumeSpawnOptions';
import { buildMachineResumeRequest } from '@/session/services/requestInactiveSessionResume';
import { validateEnvVarRecordStrict } from '@/terminal/runtime/envVarSanitization';
import { prepareExecuteSpawnSessionRequest } from './prepareExecuteSpawnSessionRequest';

// Only Home HTTP reads are replaced. Creation, metadata envelopes, resume
// projection, Agent catalog, and daemon admission use their real owners.
const network = vi.hoisted(() => ({ fetchSessionByIdCompat: vi.fn(), fetchAccountEncryptionCurrentness: vi.fn() }));
vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionByIdCompat: network.fetchSessionByIdCompat,
}));
vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>(),
  fetchAccountEncryptionCurrentness: network.fetchAccountEncryptionCurrentness,
}));

describe('connected-account session creation → inactive resume admission', () => {
  beforeEach(() => {
    network.fetchSessionByIdCompat.mockReset();
    network.fetchAccountEncryptionCurrentness.mockReset().mockResolvedValue({
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    });
  });

  it.each([
    ['claude', 'happier.agent.claude/claude-subscription', 'flat', false],
    ['claude', 'happier.agent.claude/claude-subscription', 'owner', false],
    ['codex', 'happier.agent.codex/openai-codex', 'flat', false],
    ['codex', 'happier.agent.codex/openai-codex', 'owner', false],
    ['claude', 'happier.agent.claude/claude-subscription', 'owner', true],
    ['codex', 'happier.agent.codex/openai-codex', 'owner', true],
  ] as const)('restores %s account %s before its first provider turn (layout=%s, sparse request=%s)', async (agentId, serviceKey, layout, sparse) => {
    const connectedServices = { v: 2, bindingsByServiceId: {
      [serviceKey]: { source: 'connected', selection: 'profile', profileId: 'work-account' },
    } };
    const identity = { v: 1, id: 'csm_first_connected_launch', createdAt: 123, source: 'first_spawn' };
    const { metadata } = createSessionMetadata({
      flavor: agentId, machineId: 'machine-connected', directory: '/project', startedBy: 'daemon',
      runtimeDescriptorV1: { v: 1, agentId, agent: {} },
      launchControlMetadata: captureSessionLaunchControlMetadata({ processEnvironment: {
        [HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY]: JSON.stringify(connectedServices),
        [HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY]: JSON.stringify(identity),
      } }),
    });
    const owner = createSessionOwnerMetadataV1({ metadata });
    if (!owner.ok) throw new Error(`Invalid creation metadata: ${owner.unsupportedFields.join(',')}`);
    const row = {
      id: 'session-connected', seq: 1, active: false, encryptionMode: 'plain',
      metadataVersion: 1, agentStateVersion: 0, agentState: null, dataEncryptionKey: null,
      ...(layout === 'owner' ? {
        metadataLayoutVersion: 1,
        metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata })),
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata),
      } : { metadata: JSON.stringify(metadata) }),
    };
    network.fetchSessionByIdCompat.mockResolvedValue(row);

    const clientOptions = buildInactiveSessionResumeSpawnOptions({ sessionId: row.id, rawSession: row, metadata });
    expect(clientOptions).not.toBeNull();
    if (!clientOptions) return;
    const request = buildMachineResumeRequest(clientOptions, row.id);
    const prepared = await prepareExecuteSpawnSessionRequest({
      request: { credentials: { token: 'synthetic-owner', encryption: null }, options: {
        directory: request.directory, existingSessionId: request.sessionId,
        backendTarget: request.backendTarget, agentTarget: request.agentTarget,
        ...(sparse ? {} : { connectedServices: request.connectedServices }),
        runtimeDescriptorV1: request.runtimeDescriptorV1,
      } },
      validateEnvVarRecordStrict,
    });
    expect(prepared).toMatchObject({
      normalizedExistingSessionId: row.id, effectiveResume: '',
      connectedServices: metadata.connectedServices,
      connectedServiceMaterializationIdentityV1: identity,
    });
  });
});

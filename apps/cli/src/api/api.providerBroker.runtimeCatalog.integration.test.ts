import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import {
  PROVIDER_BROKER_OPEN_HTTP_PATH_V1,
  PROVIDER_BROKER_REQUEST_ADMISSION_HTTP_PATH_V1,
} from '@happier-dev/protocol';
import { TEAM_CREDENTIAL_ACTION_PATHS_V1, TeamCredentialResourceSummaryV1Schema } from '@happier-dev/protocol/teams';

import { ApiClient } from './api';

vi.mock('axios', () => ({
  default: { post: vi.fn(), get: vi.fn(), isAxiosError: vi.fn() },
  post: vi.fn(),
  get: vi.fn(),
  isAxiosError: vi.fn(),
}));

vi.mock('@/configuration', () => ({
  configuration: { apiServerUrl: 'https://home.example' },
}));

describe('ApiClient Team credential Provider broker methods', () => {
  let api: ApiClient;

  beforeEach(async () => {
    vi.clearAllMocks();
    api = await ApiClient.create({
      token: 'account-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });
  });

  it('reads the current custodian resource projection through its canonical Action route', async () => {
    const resource = TeamCredentialResourceSummaryV1Schema.parse({
      id: 'resource-1',
      teamId: 'team-1',
      custodianAccountId: 'account-1',
      displayName: 'Shared Codex',
      enabled: true,
      revision: 7,
      disclosureCeiling: 'brokered_only',
      sessionUsePolicy: 'personal_allowed',
      source: null,
      sourcePresentation: {
        kind: 'connected_service',
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
      },
      requestPolicy: null,
      brokerPlacement: { kind: 'machine', machineId: 'broker-1' },
      allMembersDeliveryMode: null,
      groupGrants: [],
      memberGrants: [],
      readiness: { kind: 'available' },
      recoveryAction: null,
      brokerPresentation: { selectedTarget: null, eligibleTargets: [], selectedPool: null, eligiblePools: [] },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    vi.mocked(axios.post).mockResolvedValueOnce({ status: 200, data: resource });

    await expect(api.getTeamCredentialResource('resource-1')).resolves.toEqual(resource);
    expect(axios.post).toHaveBeenCalledWith(
      `https://home.example${TEAM_CREDENTIAL_ACTION_PATHS_V1['teams.credentials.get']}`,
      { resourceId: 'resource-1' },
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer account-token' }) }),
    );
  });

  it('opens a broker authority through the canonical typed endpoint', async () => {
    const request = {
      v: 1 as const,
      resourceId: 'resource-1',
      expectedResourceRevision: 1,
      modelId: 'gpt-5',
      sourceRevision: 'source-revision-1',
      initiatorMachineId: 'worker-1',
      consumer: { kind: 'session' as const, sessionId: 'session-1' },
      application: {
        agentTargetKey: 'codex',
        implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
        endpointTemplateId: 'cliproxyapi-openai-responses',
        protocol: 'openai-responses' as const,
      },
    };
    const response = { ok: false as const, reasonCode: 'broker_unavailable' as const };
    vi.mocked(axios.post).mockResolvedValueOnce({ status: 200, data: response });

    await expect(api.openTeamCredentialProviderBroker(request)).resolves.toEqual(response);
    expect(axios.post).toHaveBeenCalledWith(
      `https://home.example${PROVIDER_BROKER_OPEN_HTTP_PATH_V1}`,
      request,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer account-token' }) }),
    );
  });

  it('admits each Provider request through the canonical typed endpoint', async () => {
    const request = {
      v: 1 as const,
      authority: {
        payload: {
          v: 1 as const,
          grantId: 'grant-1',
          aud: 'happier-provider-broker-route-v1' as const,
          issuedAt: 1,
          expiresAt: 2,
          teamId: 'team-1',
          resourceId: 'resource-1',
          sourceRevision: 'source-revision-1',
          brokerPlacementFingerprint: 'c'.repeat(64),
          initiatorTokenEpoch: 0,
          initiator: { accountId: 'account-1', machineId: 'worker-1', endpointId: 'a'.repeat(64) },
          target: { custodianAccountId: 'account-2', machineId: 'broker-1', endpointId: 'b'.repeat(64) },
          consumer: { kind: 'session' as const, sessionId: 'session-1' },
          application: {
            agentTargetKey: 'codex',
            implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
            endpointTemplateId: 'cliproxyapi-openai-responses',
            protocol: 'openai-responses' as const,
          },
        },
        signature: { alg: 'Ed25519' as const, keyId: 'home', valueBase64Url: 'A'.repeat(86) },
      },
      expectedResourceRevision: 1,
      sourceMemberKey: 'source-member-1',
      requestId: 'request-1',
      requestFacts: { generation: false, routeKind: 'openai_responses' as const, modelId: 'gpt-5', reasoningEffort: null },
    };
    const response = { ok: false as const, reasonCode: 'resource_changed' as const };
    vi.mocked(axios.post).mockResolvedValueOnce({ status: 200, data: response });

    await expect(api.admitTeamCredentialProviderBrokerRequest(request)).resolves.toEqual(response);
    expect(axios.post).toHaveBeenCalledWith(
      `https://home.example${PROVIDER_BROKER_REQUEST_ADMISSION_HTTP_PATH_V1}`,
      request,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer account-token' }) }),
    );
  });
});

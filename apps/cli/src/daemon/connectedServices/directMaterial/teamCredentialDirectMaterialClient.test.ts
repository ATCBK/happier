import tweetnacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';
import {
  computeTeamCredentialSourceMemberKeyV1,
  createTeamCredentialDirectMaterialStoredV1,
} from '@happier-dev/protocol/teams';

import { createTeamCredentialDirectMaterialClient } from './teamCredentialDirectMaterialClient';
import { createHttpTeamCredentialDirectMaterialClient } from './teamCredentialDirectMaterialClient';
import {
  fetchTeamCredentialDirectMaterial,
  TeamCredentialDirectMaterialHttpContractError,
  TeamCredentialDirectMaterialHttpTransportError,
} from './teamCredentialDirectMaterialHttp';

vi.mock('./teamCredentialDirectMaterialHttp', () => ({
  fetchTeamCredentialDirectMaterial: vi.fn(),
  TeamCredentialDirectMaterialHttpContractError: class extends Error {},
  TeamCredentialDirectMaterialHttpTransportError: class extends Error {},
}));

const payload = {
  v: 1 as const,
  domain: 'happier.team-credential-direct-material' as const,
  homeServerIdentityId: 'home-1',
  teamId: 'team-1',
  resourceId: 'resource-1',
  resourceRevision: 7,
  recipientAccountId: 'recipient-1',
  sourceMember: {
    kind: 'connected_account' as const,
    service: { pluginId: 'plugin.acme', localId: 'service' },
    connectedAccountId: 'source-account',
  },
  sourceVersion: 'source-version-1',
  material: {
    kind: 'qualified_connected_account' as const,
    credential: { v: 1 as const, values: { token: 'secret' } },
    configuration: null,
    authenticationModeId: 'token',
  },
};

const use = {
  consumer: { kind: 'session' as const, sessionId: 'session-1' },
  slot: { kind: 'connected_service_purpose' as const, purpose: {
    consumer: { pluginId: 'plugin.acme', localId: 'agent' }, purpose: 'runtime',
  } },
  disclosedMember: {
    service: { pluginId: 'plugin.acme', localId: 'service' },
    accountId: 'source-account',
  },
};

describe('TeamCredentialDirectMaterialClient', () => {
  it.each(['team-1', 'other-team'])('carries only metadata for the admitted Team (%s)', async (teamId) => {
    const admittedResource = { displayName: 'Acme service', teamId };
    vi.mocked(fetchTeamCredentialDirectMaterial).mockResolvedValueOnce({
      status: 'ready',
      recipientMode: 'plain',
      stored: createTeamCredentialDirectMaterialStoredV1({ payload, recipientMode: 'plain' }),
      expected: {
        homeServerIdentityId: payload.homeServerIdentityId,
        teamId: payload.teamId,
        resourceId: payload.resourceId,
        resourceRevision: payload.resourceRevision,
        recipientAccountId: payload.recipientAccountId,
        sourceMemberKey: computeTeamCredentialSourceMemberKeyV1(payload.sourceMember),
        sourceVersion: payload.sourceVersion,
      },
      admittedResource,
    });
    const client = createHttpTeamCredentialDirectMaterialClient({
      token: 'token', teamId: payload.teamId,
      readRecipientEncryptionMaterial: async () => ({ mode: 'plain' }),
    });
    await expect(client.open({ resourceId: payload.resourceId, ...use })).resolves.toEqual(
      teamId === payload.teamId
        ? { ok: true, payload, admittedResource }
        : { ok: false, reason: 'invalid_material' },
    );
  });

  it('opens current plain material from the recipient-authorized response', async () => {
    const fetchCurrent = vi.fn(async () => ({
      ok: true as const,
      recipientMode: 'plain' as const,
      stored: createTeamCredentialDirectMaterialStoredV1({ payload, recipientMode: 'plain' }),
      expected: {
        homeServerIdentityId: 'home-1',
        teamId: 'team-1',
        resourceId: 'resource-1',
        resourceRevision: 7,
        recipientAccountId: 'recipient-1',
        sourceMemberKey: computeTeamCredentialSourceMemberKeyV1(payload.sourceMember),
        sourceVersion: 'source-version-1',
      },
    }));
    const client = createTeamCredentialDirectMaterialClient({
      fetchCurrent,
      readRecipientEncryptionMaterial: vi.fn(async () => ({ mode: 'plain' as const })),
    });
    const result = await client.open({ resourceId: 'resource-1', ...use });
    expect(result).toEqual({ ok: true, payload });
  });

  it('opens a recipient-bound E2EE tuple on first use without exposing a plain fallback', async () => {
    const recipientSecretKey = new Uint8Array(32).fill(7);
    const recipientContentPublicKey = tweetnacl.box.keyPair.fromSecretKey(recipientSecretKey).publicKey;
    const stored = createTeamCredentialDirectMaterialStoredV1({
      payload,
      recipientMode: 'e2ee',
      recipientContentPublicKey,
      randomBytes: tweetnacl.randomBytes,
    });
    const client = createTeamCredentialDirectMaterialClient({
      fetchCurrent: async () => ({
        ok: true,
        recipientMode: 'e2ee',
        admittedResource: { displayName: 'Acme service', teamId: payload.teamId },
        stored,
        expected: {
          homeServerIdentityId: 'home-1',
          teamId: 'team-1',
          resourceId: 'resource-1',
          resourceRevision: 7,
          recipientAccountId: 'recipient-1',
          sourceMemberKey: computeTeamCredentialSourceMemberKeyV1(payload.sourceMember),
          sourceVersion: 'source-version-1',
        },
      }),
      readRecipientEncryptionMaterial: async () => ({ mode: 'e2ee', secretKeyOrSeed: recipientSecretKey }),
    });

    await expect(client.open({ resourceId: 'resource-1', ...use })).resolves.toEqual({
      ok: true, payload, admittedResource: { displayName: 'Acme service', teamId: payload.teamId },
    });
  });

  it('fails closed before disclosure when currentness changes or E2EE material is unavailable', async () => {
    const fetchCurrent = vi.fn(async () => ({ ok: false as const, reason: 'source_changed' as const }));
    const client = createTeamCredentialDirectMaterialClient({
      fetchCurrent,
      readRecipientEncryptionMaterial: vi.fn(async () => ({ mode: 'e2ee_unavailable' as const })),
    });
    await expect(client.open({ resourceId: 'resource-1', ...use })).resolves.toEqual({
      ok: false,
      reason: 'source_changed',
    });
  });

  it('rejects a private payload response bound to a different requested Team', async () => {
    const client = createTeamCredentialDirectMaterialClient({
      fetchCurrent: vi.fn(async () => ({
        ok: true as const,
        recipientMode: 'plain' as const,
        stored: createTeamCredentialDirectMaterialStoredV1({ payload, recipientMode: 'plain' }),
        expected: {
          homeServerIdentityId: 'home-1', teamId: 'team-1', resourceId: 'resource-1',
          resourceRevision: 7, recipientAccountId: 'recipient-1',
          sourceMemberKey: computeTeamCredentialSourceMemberKeyV1(payload.sourceMember),
          sourceVersion: 'source-version-1',
        },
      })),
      readRecipientEncryptionMaterial: vi.fn(async () => ({ mode: 'plain' as const })),
    });
    await expect(client.open({
      teamId: 'team-2', resourceId: 'resource-1', ...use,
    })).resolves.toEqual({ ok: false, reason: 'source_changed' });
  });

  it.each([
    'team_authentication_required',
    'team_authentication_policy_unavailable',
  ] as const)('preserves canonical operation error %s from the HTTP boundary', async (error) => {
    vi.mocked(fetchTeamCredentialDirectMaterial).mockResolvedValueOnce({
      status: 'operation_error',
      error: { error },
    });
    const client = createHttpTeamCredentialDirectMaterialClient({
      token: 'token', teamId: 'team-1',
      readRecipientEncryptionMaterial: vi.fn(async () => ({ mode: 'plain' as const })),
    });

    await expect(client.open({ resourceId: 'resource-1', ...use })).resolves.toEqual({
      ok: false,
      operationError: { error },
    });
  });

  it('keeps pre-abort and in-flight abort as cancellation', async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const client = createHttpTeamCredentialDirectMaterialClient({
      token: 'token', teamId: 'team-1',
      readRecipientEncryptionMaterial: vi.fn(async () => ({ mode: 'plain' as const })),
    });
    await expect(client.open({ resourceId: 'resource-1', ...use, signal: preAborted.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });

    const inFlight = new AbortController();
    vi.mocked(fetchTeamCredentialDirectMaterial).mockImplementationOnce(async () => {
      inFlight.abort();
      throw inFlight.signal.reason;
    });
    await expect(client.open({ resourceId: 'resource-1', ...use, signal: inFlight.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('maps a genuine network failure only to temporarily_unavailable', async () => {
    vi.mocked(fetchTeamCredentialDirectMaterial).mockRejectedValueOnce(
      new TeamCredentialDirectMaterialHttpTransportError(),
    );
    const client = createHttpTeamCredentialDirectMaterialClient({
      token: 'token', teamId: 'team-1',
      readRecipientEncryptionMaterial: vi.fn(async () => ({ mode: 'plain' as const })),
    });

    await expect(client.open({ resourceId: 'resource-1', ...use })).resolves.toEqual({
      ok: false,
      reason: 'temporarily_unavailable',
    });
  });

  it('maps a malformed HTTP contract to resource_corrupt instead of endpoint availability', async () => {
    vi.mocked(fetchTeamCredentialDirectMaterial).mockRejectedValueOnce(
      new TeamCredentialDirectMaterialHttpContractError(),
    );
    const client = createHttpTeamCredentialDirectMaterialClient({
      token: 'token', teamId: 'team-1',
      readRecipientEncryptionMaterial: vi.fn(async () => ({ mode: 'plain' as const })),
    });

    await expect(client.open({ resourceId: 'resource-1', ...use })).resolves.toEqual({
      ok: false,
      reason: 'resource_corrupt',
    });
  });
});

import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAccountScopedCryptoMaterialSnapshotV1,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
} from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { readSessionMetadataTupleWriterSnapshot } from '@/session/metadata/updateSessionMetadataWithRetry';
import { reconcileRecoveredSessionMachineControl } from './reconcileRecoveredSessionMachineControl';

const http = vi.hoisted(() => ({
  fetch: vi.fn(), patch: vi.fn(), tuple: vi.fn(), currentness: vi.fn(),
}));
// These are the existing HTTP adapters; tuple ownership, projection, encryption and CAS remain real.
vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: http.fetch,
  patchSessionMetadata: http.patch,
  patchSessionMetadataEnvelopeTuple: http.tuple,
}));
vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
  fetchAccountEncryptionCurrentness: http.currentness,
}));
beforeEach(() => { http.fetch.mockReset(); http.patch.mockReset(); http.tuple.mockReset(); http.currentness.mockReset(); });
afterEach(() => vi.restoreAllMocks());

describe('recovered runner machine control', () => {
  it.each(['plain', 'e2ee'] as const)('repairs %s owner-envelope routing without retiring the publisher', async (mode) => {
    const secret = new Uint8Array(32).fill(7);
    const credentials: StoredCredentials = { token: 'recovered-' + mode, encryption: mode === 'plain' ? null : { type: 'legacy', secret } };
    const currentness = {
      mode, version: 1, signingKeyFingerprint: null,
      contentKeyFingerprint: mode === 'plain' ? null
        : convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
          createAccountScopedCryptoMaterialSnapshotV1({
            accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret },
          }).contentPublicKeyFingerprint,
        ),
      updatedAt: 1,
      recipientEnvelopeReadiness: mode === 'plain'
        ? { status: 'unavailable' as const, reason: 'plain_account' as const } : { status: 'available' as const },
    };
    http.currentness.mockResolvedValue(currentness);
    const initial = createTestMetadata({
      machineId: 'old-machine', hostPid: 1234, path: '/workspace/repo',
      summary: { text: 'Keep this', updatedAt: 1 },
      sessionWorkspaceLocationV1: { v: 1, machineId: 'old-machine', agentPath: '/sandbox/repo', machinePath: '/workspace/repo' },
    });
    const fields = buildSessionMetadataEnvelopeFields({
      credentials, accountEncryptionMode: mode, metadata: initial, agentState: null,
      ...(mode === 'plain' ? { storedContentMode: 'plain' as const }
        : { storedContentMode: 'e2ee' as const, encryptionKey: secret, encryptionVariant: 'legacy' as const }),
    });
    let stored = createSessionRecordFixture({
      id: 'recovered-' + mode, encryptionMode: mode, dataEncryptionKey: null,
      metadataLayoutVersion: 1, share: null, metadataVersion: 3, agentStateVersion: 0,
      metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata,
      agentState: fields.agentState,
    });
    http.fetch.mockImplementation(async () => stored);
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { accessKey: { id: 'binding' } } });
    http.tuple.mockImplementation(async (request) => {
      stored = { ...stored, ownerMetadata: request.patch.ownerMetadata,
        metadataVersion: stored.metadataVersion + 1, agentStateVersion: stored.agentStateVersion + 1 };
      return { success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: stored.metadataVersion }, agentState: { version: stored.agentStateVersion } };
    });
    const params = { credentials, sessionId: stored.id, machineId: 'new-machine', runnerPid: 1234 };
    await reconcileRecoveredSessionMachineControl(params);
    const read = () => readSessionMetadataTupleWriterSnapshot({ credentials, accountEncryptionCurrentness: currentness, rawSession: stored }).value.metadata;
    expect(read()).toMatchObject({
      machineId: 'new-machine', hostPid: 1234, path: initial.path, summary: initial.summary,
      sessionWorkspaceLocationV1: { ...initial.sessionWorkspaceLocationV1, machineId: 'new-machine' },
    });
    const version = stored.metadataVersion;
    await reconcileRecoveredSessionMachineControl(params);
    expect(stored.metadataVersion).toBe(version);
  });
  it('preserves the owner envelope of a different current runner', async () => {
    const credentials: StoredCredentials = { token: 'different-runner', encryption: null };
    http.currentness.mockResolvedValue({
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
    });
    const fields = buildSessionMetadataEnvelopeFields({
      credentials, accountEncryptionMode: 'plain', storedContentMode: 'plain',
      metadata: createTestMetadata({ machineId: 'handoff-target', hostPid: 5678 }), agentState: null,
    });
    const stored = createSessionRecordFixture({
      id: 'already-moved', encryptionMode: 'plain', metadataLayoutVersion: 1, share: null,
      dataEncryptionKey: null, metadataVersion: 9,
      metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata, agentState: fields.agentState,
    });
    http.fetch.mockResolvedValue(stored);
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { accessKey: { id: 'binding' } } });
    await reconcileRecoveredSessionMachineControl({
      credentials, sessionId: stored.id, machineId: 'new-machine', runnerPid: 1234,
    });
    expect(http.tuple).not.toHaveBeenCalled();
    expect(stored.ownerMetadata).toEqual(fields.ownerMetadata);
  });

});

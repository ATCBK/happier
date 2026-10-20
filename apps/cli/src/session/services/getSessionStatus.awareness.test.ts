import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import nacl from 'tweetnacl';

import { deriveAccountMachineKeyFromRecoverySecret, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { encodeBase64 } from '@/api/encryption';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';

import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { getSessionStatus } from './getSessionStatus';
import { SessionStatusActionResultV1Schema } from '@happier-dev/protocol/sessions/control/contract';

const { mockIo } = vi.hoisted(() => ({ mockIo: vi.fn() }));
vi.mock('axios', () => ({ default: { get: vi.fn(), isAxiosError: () => false } }));
vi.mock('socket.io-client', () => ({ io: mockIo }));

const sessionId = 'c123456789012345678901234';
const credentials = { token: 'test-token', encryption: null } as const;

const secret = new Uint8Array(32).fill(7);
const machineKey = deriveAccountMachineKeyFromRecoverySecret(secret);
const publicKey = nacl.box.keyPair.fromSecretKey(machineKey).publicKey;
const e2eeCredentials = { token: 'test-token', encryption: { type: 'dataKey', machineKey, publicKey } } as const;
const dataEncryptionKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
  dataKey: new Uint8Array(32).fill(19),
  recipientPublicKey: publicKey,
  randomBytes: (length) => new Uint8Array(length).fill(11),
}));

describe('getSessionStatus awareness acquisition', () => {
  beforeEach(() => vi.clearAllMocks());

  function serveRow(live: boolean) {
    const now = Date.now();
    const row = createSessionRecordFixture({
      id: sessionId,
      encryptionMode: 'plain',
      metadata: '{}',
      active: true,
      activeAt: now,
      ...(live ? {} : { latestTurnStatus: 'in_progress' as const, latestTurnStatusObservedAt: now }),
      pendingPermissionRequestCount: 0,
      pendingUserActionRequestCount: 0,
      pendingRequestObservedAt: now - 1_000,
    });
    vi.mocked(axios.get).mockImplementation(async (url) => {
      if (String(url).endsWith('/encryption/currentness')) {
        return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      }
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: row } };
      throw new Error(`Unexpected request: ${url}`);
    });
    return now;
  }

  it('returns canonical awareness alongside retained status fields without reading a transcript', async () => {
    serveRow(false);
    expect(await getSessionStatus({ credentials, idOrPrefix: sessionId, live: false })).toMatchObject({
      ok: true,
      session: { id: sessionId },
      awareness: { v: 1, sessionId, runtime: 'working', freshness: 'live', operational: { primary: 'working' } },
    });
  });

  function serveE2ee(row: Record<string, unknown>) {
    vi.mocked(axios.get).mockImplementation(async (url) => {
      if (String(url).endsWith('/encryption/currentness')) {
        return { status: 200, data: createAccountEncryptionCurrentnessFixture({
          mode: 'e2ee', recipientEnvelopeReadiness: { status: 'available' },
        }) };
      }
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) {
        return { status: 200, data: { session: createSessionRecordFixture({
          id: sessionId, encryptionMode: 'e2ee', active: true, activeAt: Date.now(), ...row,
        } as never) } };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  }

  it('reports content the opened key could not authenticate, not an absence of evidence', async () => {
    serveE2ee({
      dataEncryptionKey,
      metadata: encryptSessionPayload({
        ctx: { encryptionKey: new Uint8Array(32).fill(47), encryptionVariant: 'dataKey' },
        payload: { summary: { text: 'Security review', updatedAt: 1 } },
      }),
    });
    const result = await getSessionStatus({ credentials: e2eeCredentials, idOrPrefix: sessionId, live: false });
    expect(result).toMatchObject({ ok: true, awareness: { encryption: 'content_unavailable', availability: 'locked' } });
    expect(result).not.toHaveProperty('awareness.title');
  });

  it('preserves the typed unavailable-material failure instead of hydrating awareness anyway', async () => {
    // Status resolves the Session transport context before projecting, so an undelivered
    // envelope fails here rather than becoming a successful reply carrying a guessed state.
    serveE2ee({
      dataEncryptionKey: null, metadata: 'retained-ciphertext',
      share: { accessLevel: 'view', canApprovePermissions: false },
    });
    const result = await getSessionStatus({ credentials: e2eeCredentials, idOrPrefix: sessionId, live: false });
    expect(result).toEqual({ ok: false, code: 'encryption_material_unavailable' });
  });

  it('merges fresh socket requests before projection, preserving user-action semantics', async () => {
    const now = serveRow(true);
    bindApiSessionSocketMock(mockIo, createApiSessionSocketStub({
      onConnect(socket) {
        queueMicrotask(() => socket.trigger('update', {
          id: 'update-1', seq: 1, createdAt: now,
          body: {
            t: 'update-session', id: sessionId,
            agentState: {
              version: 1,
              value: JSON.stringify({ requests: { ask: { tool: 'AskUserQuestion', kind: 'user_action', arguments: { questions: [] }, createdAt: now } } }),
            },
          },
        }));
      },
    }));
    expect(await getSessionStatus({ credentials, idOrPrefix: sessionId, live: true })).toMatchObject({
      ok: true,
      agentState: { pendingRequestsCount: 1 },
      pendingRequests: [{ requestId: 'ask', kind: 'user_action', tool: 'AskUserQuestion' }],
      awareness: { operational: { primary: 'action_required' } },
    });
  });

  it('exposes exact pending permission and question identities through the status Action contract', async () => {
    serveE2ee({
      dataEncryptionKey,
      agentState: encryptSessionPayload({
        ctx: { encryptionKey: new Uint8Array(32).fill(19), encryptionVariant: 'dataKey' },
        payload: { requests: {
          'exec-native-pwd': { tool: 'Bash', kind: 'permission', arguments: { command: 'pwd' }, createdAt: 1, turnId: 'native-turn-1' },
          'ask-choice': { tool: 'AskUserQuestion', kind: 'user_action', arguments: { questions: [{ id: 'choice', question: 'Continue?' }] }, createdAt: 2 },
          settled: { tool: 'Bash', kind: 'permission', arguments: { command: 'pwd' }, createdAt: 1 },
        }, completedRequests: {
          settled: { tool: 'Bash', kind: 'permission', arguments: { command: 'pwd' }, createdAt: 1, completedAt: 3, status: 'approved' },
        } },
      }),
    });
    const result = await getSessionStatus({ credentials: e2eeCredentials, idOrPrefix: sessionId, live: false });
    expect(SessionStatusActionResultV1Schema.parse(result)).toMatchObject({
      ok: true,
      pendingRequests: [
        { requestId: 'exec-native-pwd', turnId: 'native-turn-1', kind: 'permission', tool: 'Bash' },
        { requestId: 'ask-choice', kind: 'user_action', tool: 'AskUserQuestion' },
      ],
    });
    expect(result).not.toHaveProperty('pendingRequests.0.arguments');
  });
});

import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bindApiSessionSocketSequenceMock,
  createApiSessionSocketStub,
  createSessionRuntimeActivityHomeStub,
  createSessionTranscriptHomeStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { createMockSession } from '@/testkit/backends/sessionFixtures';
import {
  readSessionFollowWakeInvalidationGeneration,
} from '@/agent/runtime/session/follow/sessionFollowWakeSignal';

import { ApiClient } from './api';
import { CURRENT_MACHINE_OPERATION_PROTOCOL_CAPABILITIES_V1 } from './apiMachine';
import type { ApiSessionClient } from './session/sessionClient';
import { configuration } from '@/configuration';
import { FeaturesResponseSchema } from '@happier-dev/protocol';

const { mockIo, readStoredCredentialsMock } = vi.hoisted(() => ({
  mockIo: vi.fn(),
  readStoredCredentialsMock: vi.fn(),
}));

vi.mock('socket.io-client', () => ({ io: mockIo }));
vi.mock('@/api/connection/createLoopbackReadinessProbe', () => ({
  createLoopbackReadinessProbe: () => async () => ({ status: 'ready' as const }),
}));
vi.mock('@/persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/persistence')>()),
  readStoredCredentials: readStoredCredentialsMock,
}));

describe('ApiClient ordinary Session Follow wake wiring', () => {
  let client: ApiSessionClient | null = null;

  beforeEach(() => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    mockIo.mockReset();
    readStoredCredentialsMock.mockReset().mockResolvedValue({
      token: 'ordinary-account-token',
      encryption: null,
    });
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 404, data: {} });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  });

  afterEach(async () => {
    await client?.close();
    client = null;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('binds the production captured-Home Discussion check-in reader into an ordinary Session client', async () => {
    const userSocket = createApiSessionSocketStub({ id: 'check-in-user' });
    const sessionSocket = createApiSessionSocketStub({ id: 'check-in-session' });
    bindApiSessionSocketSequenceMock(mockIo, [userSocket, sessionSocket]);
    const api = await ApiClient.create({ token: 'ordinary-account-token', encryption: null });
    api.setServerFeaturesSnapshotProvider(() => ({ status: 'ready', features: FeaturesResponseSchema.parse({
      features: { sessions: { enabled: true, conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } } }, capabilities: {},
    }) }));
    client = api.sessionSyncClient(createMockSession({ id: 'check-in-destination', encryptionMode: 'plain',
      metadataLayoutVersion: 1, metadata: { v: 1 }, agentState: null }));
    const reader: unknown = Reflect.get(client, 'readDiscussionAutonomousCheckIn');
    expect(reader).toBeTypeOf('function');
    if (typeof reader !== 'function') throw new Error('Production Discussion reader missing');
    const request = vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: {
      discussionId: 'discussion', settings: { coordination: { autonomousCheckIn: { afterTurns: null } } },
    } });
    expect(await reader({ serverId: configuration.activeServerId, discussionId: 'discussion' })).toEqual({ afterTurns: null });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      url: expect.stringContaining('/v1/discussions/discussion/settings'),
      headers: expect.objectContaining({ Authorization: 'Bearer ordinary-account-token' }),
    }));
    expect(await reader({ serverId: 'another-home', discussionId: 'discussion' })).toBeNull();
  });

  it('backs advertised wake support with exact Session invalidation and reconnect consumers when V2 changes are disabled', async () => {
    const machineId = 'ordinary-machine';
    const activityHome = createSessionRuntimeActivityHomeStub({ machineId });
    const transcriptHome = createSessionTranscriptHomeStub();
    const emitWithAck = (event: string, payload: unknown) => activityHome.answer(event, payload)
      ?? transcriptHome.answer(event, payload) ?? { ok: true };
    vi.mocked(axios.get).mockImplementation(async url => String(url).includes('/v1/access-keys/')
      ? { status: 200, data: { accessKey: 'ordinary-machine-access' } }
      : { status: 404, data: {} });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(FeaturesResponseSchema.parse({
      features: {},
      capabilities: { session: { runtimeActivity: { protocolVersion: 2 },
        pendingInput: { protocolVersion: 3 }, publisherAuthority: { protocolVersion: 1 } } },
    }))));
    const userSocket = createApiSessionSocketStub({ id: 'ordinary-user-socket' });
    const firstSessionSocket = createApiSessionSocketStub({
      id: 'ordinary-session-socket-1',
      disconnectReason: 'transport close',
      emitWithAck,
    });
    const reconnectedSessionSocket = createApiSessionSocketStub({
      id: 'ordinary-session-socket-2',
      emitWithAck,
    });
    bindApiSessionSocketSequenceMock(mockIo, [
      userSocket,
      firstSessionSocket,
      reconnectedSessionSocket,
    ]);

    const api = await ApiClient.create({
      token: 'ordinary-account-token',
      encryption: null,
    });
    const beforeConstruction = readSessionFollowWakeInvalidationGeneration();
    client = api.sessionSyncClient(createMockSession({
      id: 'destination-session',
      encryptionMode: 'plain',
      metadataLayoutVersion: 1,
      metadata: { v: 1, machineId },
      agentState: null,
    }), {
      // This connection-only fixture has not activated a host runtime yet.
      durableMutationDeliveryInitiallyActive: false,
    });

    await vi.waitFor(() => {
      expect(readSessionFollowWakeInvalidationGeneration()).toBe(beforeConstruction + 1);
    });
    expect(CURRENT_MACHINE_OPERATION_PROTOCOL_CAPABILITIES_V1.sessionFollow).toEqual({
      contextV1: true,
      wakeOnHumanChangeV1: true,
    });

    const afterConnect = readSessionFollowWakeInvalidationGeneration();
    firstSessionSocket.trigger('session', {
      id: 'wrong-session-change',
      createdAt: 1,
      body: { t: 'session-changed', sessionId: 'other-session' },
    });
    expect(readSessionFollowWakeInvalidationGeneration()).toBe(afterConnect);

    firstSessionSocket.trigger('session', {
      id: 'exact-session-change',
      createdAt: 2,
      body: { t: 'session-changed', sessionId: 'destination-session' },
    });
    expect(readSessionFollowWakeInvalidationGeneration()).toBe(afterConnect + 1);

    const beforeReconnect = readSessionFollowWakeInvalidationGeneration();
    firstSessionSocket.disconnect();
    await vi.waitFor(() => expect(reconnectedSessionSocket.connect).toHaveBeenCalledTimes(1), {
      timeout: 3_000,
    });
    await vi.waitFor(() => {
      expect(readSessionFollowWakeInvalidationGeneration()).toBe(beforeReconnect + 1);
    });
  });
});

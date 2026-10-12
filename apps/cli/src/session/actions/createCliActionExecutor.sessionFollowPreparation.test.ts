import { afterEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import nacl from 'tweetnacl';
import {
  accountSettingsParse,
  FeaturesResponseSchema,
  SessionFollowSourceKeyPrepareRequestV1Schema,
  computeRunnerMachineContentKeyFingerprintV1,
  normalizeActionsSettingsV1,
  sealEncryptedDataKeyEnvelopeV1,
  sealRunnerMachineContentKeyVerifierFactV1,
  signRunnerMachineContentKeyBindingV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';

import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { configuration } from '@/configuration';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import {
  createAccountEncryptionCurrentnessFixture,
  createSessionRecordFixture,
} from '@/testkit/backends/sessionFixtures';

import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

// Only the network boundary is substituted; credential enrichment, Follow
// mutation/preparation, envelope opening and exact Machine RPC remain real.
const io = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io }));

const sourceSessionId = 'c111111111111111111111111';
const destinationSessionId = 'c222222222222222222222222';
const machineId = 'runner-machine';
const serverIdentityId = 'srv_follow_home';
const accountId = 'account-1';
const machineKey = new Uint8Array(32).fill(7);
const credentials = {
  token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature',
  credentialProvenance: 'stored_session' as const,
  encryption: {
    type: 'dataKey' as const,
    publicKey: nacl.box.keyPair.fromSecretKey(machineKey).publicKey,
    machineKey,
  },
};
const sourceKey = new Uint8Array(32).fill(11);
const runnerKey = new Uint8Array(32).fill(13);
const randomBytes = (length: number) => new Uint8Array(length).fill(17);
const sealKey = (dataKey: Uint8Array) => encodeBase64(sealEncryptedDataKeyEnvelopeV1({
  dataKey, recipientPublicKey: credentials.encryption.publicKey, randomBytes,
}));

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('credentialed CLI relation source-key preparation composition', () => {
  it.each(([
    { name: 'active Home authenticated context', fixed: false, provenance: 'authenticated', plain: false, prepares: true },
    { name: 'explicit verified Home', fixed: true, provenance: 'public', plain: false, prepares: true },
    { name: 'unverified active Home', fixed: false, provenance: 'public', plain: false, prepares: false },
    { name: 'Plain source without Home identity', fixed: false, provenance: 'public', plain: true, prepares: false },
    { name: 'persistent destination without standalone source key', fixed: true, provenance: 'public', plain: false, prepares: false,
      persistent: true, standaloneSourceKey: false },
    { name: 'Runner destination without standalone source key', fixed: true, provenance: 'public', plain: false, prepares: false,
      persistent: false, standaloneSourceKey: false },
  ] as const).flatMap((scenario) => (['follow', 'reports_to', 'spawn'] as const).map((relation) => ({
    persistent: false, standaloneSourceKey: true, ...scenario, relation,
  }))))('$name ($relation)', async ({ fixed, provenance, plain, prepares, persistent, standaloneSourceKey, relation }) => {
    const serverUrl = normalizeServerHttpBaseUrl(fixed ? 'https://fixed-follow.example.test' : configuration.apiServerUrl);
    // Follow-source mutation is a dangerous CLI Action. Keep the production
    // approval owner wired (the credentialed artifact store remains available)
    // while using the canonical persisted waiver for this focused transport
    // composition, so the assertion reaches the Follow key-preparation seam.
    const actionsSettings = normalizeActionsSettingsV1({
      v: 1,
      approvalWaivedSurfaces: { 'session.follow.sources.set': ['cli'], 'session.reports_to.set': ['cli'], 'session.spawn_new': ['cli'] },
    });
    const app = fastify();
    const restore = installAxiosFastifyAdapter({ app, origin: new URL(serverUrl).origin });
    const events: string[] = [];
    let creationCorrespondence: unknown;
    // Account validation and exact daemon creation are network boundaries;
    // target normalization, create settlement and key preparation remain real.
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ id: accountId }), { status: 200 }));
    app.post('/v2/sessions/lookup-by-tags', async () => ({ sessions: [] }));
    const source = {
      sourceSessionId, destinationSessionId, deliveryState: 'eligible', hasPendingUpdates: false,
    };
    app.put(`/v2/sessions/${destinationSessionId}/follows/sessions/${sourceSessionId}`, async () => {
      events.push('edge_committed');
      return { changed: true, source };
    });
    const reportsTo = { ok: true, sessionId: sourceSessionId, leadSessionId: destinationSessionId, attachedAt: 100 };
    app.post(`/v1/sessions/${sourceSessionId}/reports-to`, async () => {
      events.push('edge_committed');
      return reportsTo;
    });
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'e2ee' }));
    app.get('/v2/sessions/:sessionId', async (request) => {
      const id = (request.params as { sessionId: string }).sessionId;
      return { session: createSessionRecordFixture({
        id,
        encryptionMode: plain && id === sourceSessionId ? 'plain' : 'e2ee',
        dataEncryptionKey: id === sourceSessionId && (plain || !standaloneSourceKey) ? null : sealKey(sourceKey),
        metadata: plain && id === sourceSessionId
          ? JSON.stringify({ sessionCreationCorrespondenceV1: creationCorrespondence })
          : encodeBase64(encrypt(id === sourceSessionId && !standaloneSourceKey ? machineKey : sourceKey, 'dataKey',
            { machineId, sessionCreationCorrespondenceV1: creationCorrespondence })),
      }) };
    });
    const signing = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
    const bindingPayload = {
      v: 1 as const,
      purpose: 'happier.ephemeral-runner.machine-content-key' as const,
      homeServerIdentityId: serverIdentityId,
      activationId: '11111111-1111-4111-8111-111111111111',
      creatorAccountId: accountId,
      machineId,
      installationId: 'runner-installation',
      machineContentKeyFingerprint: computeRunnerMachineContentKeyFingerprintV1(runnerKey),
    };
    app.get(`/v1/machines/${machineId}`, async () => {
      events.push('exact_machine');
      return { machine: {
        id: machineId,
        kind: persistent ? 'persistent' : 'ephemeral_session_runner',
        storageMode: 'e2ee',
        installationId: bindingPayload.installationId,
        revokedAt: null,
        replacedByMachineId: null,
        dataEncryptionKey: sealKey(runnerKey),
        runnerContentKeyBinding: {
          ...signRunnerMachineContentKeyBindingV1({ payload: bindingPayload, activationSigningSecretKey: signing.secretKey }),
          creatorVerifierFactCiphertext: sealRunnerMachineContentKeyVerifierFactV1({
            payload: { v: 1, activationId: bindingPayload.activationId, machineId,
              activationSigningPublicKey: encodeBase64(signing.publicKey, 'base64url') },
            material: credentials.encryption,
            randomBytes,
          }),
        },
      } };
    });
    const preparedRequests: unknown[] = [];
    const runnerContent: SocketRpcContent = { mode: 'e2ee', cipher: {
      encryptRaw: async value => encodeBase64(encrypt(runnerKey, 'dataKey', value)),
      decryptRaw: async ciphertext => decrypt(runnerKey, 'dataKey', decodeBase64(ciphertext)),
    } };
    const socket = createApiSessionSocketStub({ emitWithAck: async (event, rawCall) => {
      expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
      // This is the untyped socket network boundary, narrowed before use.
      const call = rawCall as { method: string; params: string; authorization: unknown };
      expect(call.method).toBe(`${machineId}:${RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE}`);
      const decoded = await socketRpcCodec.decodeRequestParams(runnerContent, call.params, call.method);
      const request = SessionFollowSourceKeyPrepareRequestV1Schema.parse(decoded.params);
      preparedRequests.push(request);
      expect(call.authorization).toEqual({ kind: 'session.follow.sourceKey.prepare', sourceSessionId, destinationSessionId });
      return {
        ok: true, result: await socketRpcCodec.encodeResponse(runnerContent, { v: 1, outcome: 'installed' }, decoded.callId),
      };
    } });
    io.mockReturnValue(socket);
    const executorBase = {
      credentials,
      machineId: 'sender-machine',
      resolveServerFeaturesSnapshot: async () => ({
        status: 'ready' as const, provenance,
        features: FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId } } }),
      }),
      actionsSettingsProvider: {
        getActionsSettings: () => actionsSettings,
        getAccountSettings: () => accountSettingsParse({ actionsSettingsV1: actionsSettings }),
      },
      pluginActionExecutionOwner: 'current_process',
      sessionSpawnDirectTargetTransport: {
        machineId: 'sender-machine',
        prepare: async () => ({ ok: true as const, directory: '/repo', directoryKind: 'path' as const,
          directoryCreationRequired: false, checkout: null }),
        spawnedSession: {
          spawn: async (request: import('@/rpc/handlers/spawnSessionOptionsContract').SpawnDaemonSessionRequest) => {
            creationCorrespondence = request.sessionCreationCorrespondence;
            events.push('edge_committed');
            return { type: 'success', sessionId: sourceSessionId, sessionCreationOutcome: {
              disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] },
            } };
          },
          resolveSpawnSessionByNonce: async () => ({ status: 'not_found' as const }),
        },
      },
    } as const;
    const executor = createCliActionExecutorFromCredentials(fixed
      ? { ...executorBase, serverId: 'fixed-home', serverApiUrl: serverUrl, serverIdentityId }
      : executorBase);
    try {
      const result = relation === 'follow'
        ? await executor.execute('session.follow.sources.set', { sourceSessionId, destinationSessionId }, { surface: 'cli' })
        : relation === 'reports_to'
          ? await executor.execute('session.reports_to.set', { sessionId: sourceSessionId, leadSessionId: destinationSessionId, expectedLeadSessionId: null }, { surface: 'cli' })
          : await executor.execute('session.spawn_new', { creationKey: 'source-key-child',
            executionTarget: { serverId: fixed ? 'fixed-home' : configuration.activeServerId, machineId: 'sender-machine' },
            directory: { kind: 'path', path: '/repo' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            connectedServices: { v: 2, bindingsByServiceId: {} }, reportsTo: { sessionId: destinationSessionId },
          }, { surface: 'cli' });
      if (relation === 'spawn') {
        expect(result, JSON.stringify({ result, events })).toMatchObject({ ok: true, result: {
          type: 'success', sessionId: sourceSessionId,
          sourceKeyPreparation: prepares ? { kind: 'prepared' } : plain || persistent ? { kind: 'not_needed' }
            : { kind: 'waiting', reason: standaloneSourceKey ? 'runner_unreachable' : 'source_key_unavailable' },
        } });
      } else if (prepares || plain || persistent) {
        expect(result, JSON.stringify({ result, events })).toMatchObject({ ok: true, result: relation === 'follow' ? { changed: true, source }
          : relation === 'reports_to' ? reportsTo : { type: 'success', sessionId: sourceSessionId } });
      } else {
        expect(result, JSON.stringify({ result, events })).toMatchObject({ ok: false, errorCode: 'session_follow_source_key_preparation_waiting',
          details: { edgeCommitted: true, reason: standaloneSourceKey ? 'runner_unreachable' : 'source_key_unavailable' } });
      }
      expect(events).toEqual(prepares || !standaloneSourceKey ? ['edge_committed', 'exact_machine'] : ['edge_committed']);
      expect(preparedRequests).toEqual(prepares ? [{
        v: 1, sourceSessionId, destinationSessionId, sourceDataEncryptionKeyBase64: encodeBase64(sourceKey),
      }] : []);
      if (prepares) expect(io).toHaveBeenCalledWith(serverUrl, expect.objectContaining({
        auth: expect.objectContaining({ token: credentials.token, clientType: 'user-scoped' }),
      }));
    } finally {
      restore();
      await app.close();
    }
  });
});

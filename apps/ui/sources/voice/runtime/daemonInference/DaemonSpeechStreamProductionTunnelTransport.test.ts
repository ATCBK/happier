import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DirectRouteGrantRequestV2Schema, MACHINE_PLAIN_DATA_KEY_MARKER,
  MachineLiveStreamRelayCapsV1Schema, PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
  PEER_TCP_TUNNEL_STREAM_PATH, PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
  PEER_TCP_TUNNEL_RELAY_AUTHORIZATION_AUDIENCE_V1, PeerTcpTunnelRelayEnvelopeSchema,
  createPeerApplicationAuthorityDigestV1, createSpeechTranscriptionApplicationAuthorityDigestV1,
  deriveBoxPublicKeyFromSeed, encodeBase64, decodeBase64, openEncryptedDataKeyEnvelopeV1,
  decodePeerApplicationEncryptedFrameV1, encodePeerApplicationEncryptedFrameV1,
  createPeerApplicationEncryptionAadV1, createPeerApplicationEncryptionNonceV1,
  PEER_APPLICATION_ENCRYPTION_INSTALL_CONFIRMATION_V1,
  type PeerTcpTunnelRelayAuthorizationV2,
} from '@happier-dev/protocol';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import {
  decodePeerTcpTunnelBinarySubstreamFrame, decodePeerTcpTunnelBinaryFrameForSession,
  encodePeerTcpTunnelBinaryFrameForSubstream, type PeerTcpTunnelFrame,
} from '@happier-dev/peer-transport/duplexFrames';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

const network = await installSessionOpsNetworkBoundary();
vi.mock('@more-tech/react-native-libsodium', () => import('libsodium-wrappers'));
vi.mock('@/platform/cryptoRandom', () => import('@/platform/cryptoRandom.node'));
// Native require() consumers must read the same app-published Sync singleton
// as the Vite-imported Account restoration and storage owners.
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { createPlainAccountEncryptionCurrentnessFixture } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
const { createEncryptionFromAuthCredentials } = await import('@/auth/encryption/createEncryptionFromAuthCredentials');
const { resolveAccountScopedCryptoMaterialFromCredentials } = await import('@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials');
const { createAccountScopedCryptoMaterialSnapshotV1 } = await import('@happier-dev/protocol/crypto/accountScopedCipher');
const { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } = await import('@happier-dev/protocol/account/encryptionKeyFingerprintV1');
const { resolveAccountStorageContext } = await import('@/sync/encryption/accountStorageContext');
const sodium = (await import('libsodium-wrappers')).default;
await sodium.ready;
const { createMachineFixture } = await import('@/dev/testkit');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { storage } = await import('@/sync/domains/state/storage');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { openAes256GcmBytes, sealAes256GcmBytes } = await import('@/encryption/aes256GcmBytes');
const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
const { openProductionVoiceMediaTunnel } = await import('./DaemonSpeechStreamProductionTunnelTransport');
const { daemonSpeechStreamDiagnostics } = await import('./daemonSpeechStreamDiagnostics');
const { installDaemonSpeechStreamQaRouteRequirement } = await import('./daemonSpeechStreamQaRouteRequirement');

const HOME = 'https://speech-peer.example.test';
const PORT = 3005;
const FORMAT = { sampleRateHz: 16_000, channelCount: 1, bitsPerSample: 16, ffmpegCodec: 'pcm_s16le' } as const;
const originalState = { settings: storage.getState().settings, machines: storage.getState().machines,
  machineListByServerId: storage.getState().machineListByServerId };
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let direct = true;
let relay = true;
let mintVersions = [2];
let applicationCaps: { maxDurationMs?: number; maxTotalBytes?: number } = {};
let startFailure: 'response' | 'throw' | null = null;
let finishFailure = false;
let cancelFailure = false;
let closeFailure = false;
let confirmation = PEER_APPLICATION_ENCRYPTION_INSTALL_CONFIRMATION_V1;
let grantFailure = false;
let authorization: PeerTcpTunnelRelayAuthorizationV2 | null = null;
const recipientSeed = new Uint8Array(32).fill(11);
const recipientKey = encodeBase64(deriveBoxPublicKeyFromSeed(recipientSeed), 'base64url');
let installedKey: Uint8Array | null = null;
let highestAcknowledgedInput = -1;
const grants: unknown[] = [];
const opens: unknown[] = [];
const receivedPcm: Uint8Array[] = [];
const physicalSockets: typeof network.socketBoundaries = [];

function features() {
  return FeaturesResponseSchema.parse({ features: {
    voice: { enabled: true }, execution: { runs: { enabled: true } }, machines: {
      enabled: true, tunnel: { enabled: true, directPeer: { enabled: direct }, serverRouted: { enabled: true } },
      liveStream: { enabled: true, directPeer: { enabled: direct }, serverRouted: { enabled: relay } },
    },
  }, capabilities: { machines: {
    peerMediation: { tcpTunnelRelayAuthorizationMintVersions: mintVersions },
    tunnel: { directPeer: { allowedPorts: [] }, serverRouted: { supportedEncodings: [PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2] } },
    liveStream: { serverRouted: { caps: relay ? MachineLiveStreamRelayCapsV1Schema.parse({
      maxBitrateBps: 128_000, maxFramesPerSecond: 50, maxFrameBytes: 8_192, ...applicationCaps,
      maxConcurrentStreamsPerAccount: 2, maxConcurrentStreamsPerSocket: 1, maxConcurrentStreamsPerMachine: 2,
    }) : null, disabledReason: relay ? null : 'relay_not_enabled' } },
  } } });
}
function publishFeatures() {
  primeServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId,
    snapshot: { status: 'ready', features: features() } });
}
function selectMachine(hasEndpoint = true, httpPort: number | null = PORT) {
  const machine = createMachineFixture({ id: 'machine-1', activeAt: Date.now(), daemonState: {
    httpPort,
    ...(hasEndpoint ? { peerMediation: { loopback: { endpoint: {
      v: 1, routeKind: 'loopback_direct', url: 'http://127.0.0.1:39001',
      endpointFingerprint: 'fingerprint-1', expiresAt: Date.now() + 600_000,
    } } } } : {}),
  } });
  storage.setState({ machines: { ...originalState.machines, [machine.id]: machine },
    machineListByServerId: { ...originalState.machineListByServerId, [account.home.id]: [machine] } });
}
function chunkResult(sequence: number) {
  return { ok: true, streamId: 'stream-1', generation: 7, ackSeq: sequence,
    events: [{ type: 'partial', seq: sequence, text: 'hel', isEndpoint: false, confidence: null }] };
}
function finishResult(ackSeq: number) {
  return { ok: true, streamId: 'stream-1', generation: 7, ackSeq,
    finalText: 'hello', language: 'en', modelPackId: 'stt-pack-1', events: [] };
}
async function daemonResponse(substreamId: string, frame: Extract<PeerTcpTunnelFrame, { kind: 'data' }>) {
  let responseBytes: Uint8Array;
  if (!authorization) {
    receivedPcm.push(frame.payload);
    highestAcknowledgedInput = frame.sequence;
    responseBytes = new TextEncoder().encode(JSON.stringify(chunkResult(frame.sequence)));
  } else {
    const encrypted = decodePeerApplicationEncryptedFrameV1(frame.payload);
    if (!encrypted) throw new Error('Expected encrypted daemon carrier bytes');
    if (encrypted.kind === 'install') installedKey = openEncryptedDataKeyEnvelopeV1({
      envelope: decodeBase64(encrypted.encryptedDataKeyEnvelopeBase64Url!, 'base64url'),
      recipientSecretKeyOrSeed: recipientSeed,
    });
    if (!installedKey) throw new Error('Missing installed daemon key');
    const binding = authorization.payload;
    const authorityDigest = createPeerApplicationAuthorityDigestV1(authorization);
    const aad = (direction: 'client_to_daemon' | 'daemon_to_client') => createPeerApplicationEncryptionAadV1({
      authorityDigest, accountId: binding.accountId, machineId: binding.targetMachineId, tunnelId: binding.tunnelId,
      applicationKind: 'speech_transcription', applicationAttemptId: 'request-1',
      applicationAuthorityDigest: createSpeechTranscriptionApplicationAuthorityDigestV1('request-1'),
      direction, streamId: 'stream-1', generation: 7, substreamId, sequence: frame.sequence, phase: encrypted.kind,
    });
    const plaintext = await openAes256GcmBytes({ key: installedKey,
      nonce: createPeerApplicationEncryptionNonceV1({ direction: 'client_to_daemon', phase: encrypted.kind, sequence: frame.sequence }),
      aad: aad('client_to_daemon'), ciphertext: decodeBase64(encrypted.ciphertextBase64Url, 'base64url') });
    if (encrypted.kind === 'data') {
      receivedPcm.push(plaintext);
      highestAcknowledgedInput = frame.sequence - 1;
    }
    const reply = encrypted.kind === 'install' ? confirmation
      : JSON.stringify(encrypted.kind === 'finish' ? finishResult(highestAcknowledgedInput) : chunkResult(frame.sequence - 1));
    const nonce = createPeerApplicationEncryptionNonceV1({ direction: 'daemon_to_client', phase: encrypted.kind, sequence: frame.sequence });
    const ciphertext = await sealAes256GcmBytes({ key: installedKey, nonce, aad: aad('daemon_to_client'),
      plaintext: new TextEncoder().encode(reply) });
    responseBytes = encodePeerApplicationEncryptedFrameV1({ v: 1, kind: encrypted.kind,
      nonceBase64Url: encodeBase64(nonce, 'base64url'), ciphertextBase64Url: encodeBase64(ciphertext, 'base64url') });
  }
  return encodePeerTcpTunnelBinaryFrameForSubstream({ substreamId, frame: {
    ...frame, direction: 'daemon_to_client', payload: responseBytes,
  } });
}

/** Only the browser WebSocket ABI is replaced; tunnel framing, policy and sender stay real. */
class NativeWebSocket {
  static instances: NativeWebSocket[] = [];
  binaryType?: string;
  onopen?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: unknown) => void;
  onclose?: () => void;
  close = vi.fn(() => { if (closeFailure) throw new Error('native_close_failed'); });
  sent: Uint8Array[] = [];
  constructor(readonly url: string) {
    NativeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(payload: string | Uint8Array) {
    if (!(payload instanceof Uint8Array)) throw new Error('Expected binary tunnel bytes');
    this.sent.push(payload);
    const decoded = decodePeerTcpTunnelBinarySubstreamFrame({
      frame: payload, maxBinaryHeaderBytes: 65_536, maxRawPayloadBytes: 65_536,
    });
    if (decoded.ok && decoded.frame.kind === 'data') {
      void daemonResponse(decoded.substreamId, decoded.frame).then(data => this.onmessage?.({ data }));
    }
  }
}
async function mint(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(String(input));
  if (url.pathname.endsWith('/tunnel/open')) {
    const open: unknown = JSON.parse(String(init?.body));
    opens.push(open);
    const tunnelId = (open as { tunnelId: string }).tunnelId;
    return Response.json({ v: 1, tunnelId, streamPath: PEER_TCP_TUNNEL_STREAM_PATH,
      encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2, initialWindowBytes: 1_048_576, maxFrameBytes: 65_536 });
  }
  if (!url.pathname.endsWith('/route-grants')) throw new Error('Unexpected peer HTTP path: ' + url.pathname);
  if (grantFailure) return Response.json({ ok: false, reasonCode: 'grant_missing' }, { status: 503 });
  const body: unknown = JSON.parse(String(init?.body));
  grants.push(body);
  const request = body as { kind?: string; scope: { tunnelId: string }; relaySocketId: string; machineId: string };
  if (request.kind === 'ephemeral_ed25519') {
    const directRequest = DirectRouteGrantRequestV2Schema.parse(body);
    return Response.json({ ok: true, grant: {
      payload: { v: 2, grantId: 'grant-v2', accountId: 'artifact-account', machineId: directRequest.machineId,
        flowKind: directRequest.flowKind, routeKind: directRequest.routeKind, scope: directRequest.scope,
        iat: Date.now(), exp: Date.now() + 600_000, aud: 'happier-daemon-route-grant',
        endpointFingerprint: directRequest.endpointFingerprint, proofKind: directRequest.kind,
        ephemeralPublicKeyBase64Url: directRequest.ephemeralPublicKeyBase64Url },
      signature: { keyId: 'key-1', alg: 'Ed25519', valueBase64Url: Buffer.from(new Uint8Array(64).fill(2)).toString('base64url') },
    } });
  }
  authorization = {
    payload: { v: 2, grantId: 'relay-grant-1', accountId: 'artifact-account', targetMachineId: 'machine-1',
      flowKind: 'voice_media', routeKind: 'server_relay', tunnelId: request.scope.tunnelId,
      applicationKind: 'speech_transcription', applicationAttemptId: 'request-1',
      applicationAuthorityDigest: createSpeechTranscriptionApplicationAuthorityDigestV1('request-1'),
      relaySocketId: request.relaySocketId, destination: { host: '127.0.0.1', port: PORT },
      capProfileId: 'default', maxFrameBytes: 65_536, maxIdleMs: 30_000, maxDurationMs: 300_000,
      maxTotalBytes: 8_388_608, iat: Date.now(), exp: Date.now() + 600_000,
      aud: PEER_TCP_TUNNEL_RELAY_AUTHORIZATION_AUDIENCE_V1 },
    signature: { keyId: 'relay-key-1', alg: 'Ed25519', valueBase64Url: 'signature' },
  };
  return Response.json({ ok: true, relayAuthorization: authorization });
}
async function sender() {
  const client = new DaemonVoiceInferenceClient({ createRequestId: () => 'request-1' });
  return await client.createStreamingSttSender({ packId: 'stt-pack-1', language: 'en' });
}
function receipt() { return daemonSpeechStreamDiagnostics.snapshot().lastBinaryTunnelReceipt; }
describe('DaemonSpeechStreamProductionTunnelTransport real producers', () => {
  beforeEach(async ({ task }) => {
    network.resetRequests();
    const home = await network.addHome(HOME, 'artifact-account');
    const e2eeKind = task.name.includes('secret credentials') ? 'secret'
      : task.name.includes('data-key credentials') ? 'data-key' : null;
    const contentKeyPair = e2eeKind === 'data-key' ? sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(7)) : null;
    const credentials = e2eeKind === 'secret'
      ? { token: home.token, secret: Buffer.from(new Uint8Array(32).fill(1)).toString('base64url') }
      : contentKeyPair ? { token: home.token, encryption: {
        publicKey: Buffer.from(contentKeyPair.publicKey).toString('base64'),
        machineKey: Buffer.from(contentKeyPair.privateKey).toString('base64'),
      } } : { token: home.token };
    const encryption = e2eeKind ? await createEncryptionFromAuthCredentials(credentials) : null;
    const encryptedSettings = encryption ? await encryption.encryptRaw({}) : null;
    const materialSnapshot = e2eeKind ? createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee', material: resolveAccountScopedCryptoMaterialFromCredentials(credentials),
      ...(contentKeyPair ? { dataKeyPublicKey: contentKeyPair.publicKey } : {}),
    }) : null;
    direct = true; relay = true; mintVersions = [2]; applicationCaps = {};
    startFailure = null; finishFailure = false; cancelFailure = false; closeFailure = false;
    confirmation = PEER_APPLICATION_ENCRYPTION_INSTALL_CONFIRMATION_V1; grantFailure = false;
    authorization = null; installedKey = null; highestAcknowledgedInput = -1;
    grants.length = 0; opens.length = 0; receivedPcm.length = 0;
    NativeWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', NativeWebSocket);
    vi.stubGlobal('fetch', mint);
    // Plain cases carry only tokens. The two legacy credential-kind vectors
    // restore actual E2EE Accounts and content fingerprints, never Plain keys.
    account = await restoreServerAccountForTest({ serverUrl: HOME, accountId: 'artifact-account', credentials,
      credentialScope: 'restored-home', request: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/health') return new Response(null, { status: 200 });
        if (path === '/v1/features') return Response.json(features());
        if (path === '/v1/account/encryption') return Response.json({ mode: e2eeKind ? 'e2ee' : 'plain', updatedAt: 0 });
        if (path === '/v1/account/encryption/currentness') return Response.json(materialSnapshot ? {
          mode: 'e2ee', version: 0, signingKeyFingerprint: null,
          contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(materialSnapshot.contentPublicKeyFingerprint),
          updatedAt: 0, recipientEnvelopeReadiness: { status: 'available' },
        } : createPlainAccountEncryptionCurrentnessFixture({ version: 0, updatedAt: 0 }));
        if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'artifact-account', timestamp: 1 });
        if (path === '/v2/account/settings') return Response.json({ version: 0,
          content: encryptedSettings ? { t: 'encrypted', c: encryptedSettings } : { t: 'plain', v: {} } });
        if (path.endsWith('/route-grants')) return await mint(input, init);
        if (!e2eeKind && path.startsWith('/v1/machines/')) return Response.json({ machine: { id: 'machine-1', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } });
        return null;
      } });
    await vi.waitFor(() => expect(storage.getState().profile.id).toBe('artifact-account'));
    storage.getState().applySettingsLocal({ experiments: true, featureToggles: {
      voice: true, 'execution.runs': true, 'voice.agent': true, 'voice.daemonInference': true, machines: true, 'machines.liveStream': true,
    }, voice: { ...storage.getState().settings.voice, executionMachine: {
      ...storage.getState().settings.voice.executionMachine, mode: 'fixed', machineId: 'machine-1',
    } } });
    selectMachine();
    publishFeatures();
    network.setRpcResponder(async ({ method, payload }) => {
      const input = payload as { requestId?: string; finalSeq?: number };
      if (method.endsWith('.start')) {
        if (startFailure === 'throw') throw new Error('daemon_start_failed');
        if (startFailure === 'response') return { ok: false, errorCode: 'runtime_unavailable', error: 'daemon_start_failed' };
        highestAcknowledgedInput = -1;
        return { ok: true, requestId: input.requestId, streamId: 'stream-1', generation: 7, ackSeq: -1, format: FORMAT,
          ...(authorization ? { peerApplicationEncryption: { v: 1, suite: 'aes-256-gcm', recipientPublicKeyBase64Url: recipientKey } } : {}) };
      }
      if (method.endsWith('.finish')) {
        if (finishFailure) return { ok: false, errorCode: 'runtime_unavailable', error: 'daemon_finish_failed' };
        return finishResult(highestAcknowledgedInput);
      }
      if (method.endsWith('.cancel')) {
        if (cancelFailure) return { ok: false, errorCode: 'runtime_unavailable', error: 'daemon_cancel_failed' };
        return { ok: true, streamId: 'stream-1', generation: 7 };
      }
      throw new Error('Unexpected compatibility RPC: ' + method);
    });
    const configure: Parameters<typeof network.setSocketConfigurator>[0] = boundary => {
      if (!physicalSockets.includes(boundary)) physicalSockets.push(boundary);
      boundary.socket.id = 'socket-test';
      boundary.socket.emit.mockImplementation((event, raw) => {
        if (event !== PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT) return;
        const envelope = PeerTcpTunnelRelayEnvelopeSchema.parse(raw);
        if (envelope.v !== 2) return;
        const session = decodePeerTcpTunnelBinaryFrameForSession({
          frame: envelope.frame, maxBinaryHeaderBytes: 65_536, maxRawPayloadBytes: 65_536,
        });
        if (session.ok && session.frame.kind === 'close') {
          if (closeFailure) throw new Error('native_close_failed');
          return;
        }
        const decoded = decodePeerTcpTunnelBinarySubstreamFrame({
          frame: envelope.frame, maxBinaryHeaderBytes: 65_536, maxRawPayloadBytes: 65_536,
        });
        if (decoded.ok && decoded.frame.kind === 'data') void daemonResponse(decoded.substreamId, decoded.frame).then(frame => {
          boundary.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
            v: 2, scopeUserId: 'artifact-account', sender: { kind: 'machine', machineId: 'machine-1' },
            recipient: { kind: 'user', socketId: boundary.socket.id },
            encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2, frame,
          });
        });
      });
    };
    physicalSockets.forEach(configure);
    network.socketBoundaries.forEach(configure);
    network.setSocketConfigurator(configure);
  });
  afterEach(async () => {
    await account?.dispose();
    storage.setState(originalState);
    resetServerFeaturesClientForTests();
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });

  it('fails closed before native admission when QA requires an unavailable relay', async () => {
    vi.stubEnv('EXPO_PUBLIC_DEBUG', '1');
    relay = false; publishFeatures();
    const release = installDaemonSpeechStreamQaRouteRequirement({ sessionId: 'qa-session', routeKind: 'server_relay' });
    try {
      await expect(new DaemonVoiceInferenceClient({ createRequestId: () => 'request-1' })
        .createStreamingSttSender({ sessionId: 'qa-session', packId: 'stt-pack-1', language: 'en' }))
        .rejects.toThrow('voice_qa_required_server_relay_unavailable');
    } finally { release(); }
    expect(grants).toEqual([]); expect(NativeWebSocket.instances).toEqual([]);
  });
  it('admits direct voice without TCP port quotas and retires failed start before retry', async () => {
    const first = await sender(); expect(first.transportKind).toBe('binary_tunnel');
    startFailure = 'response';
    await expect(first.start()).rejects.toThrow();
    const socket = NativeWebSocket.instances[0]!;
    expect(socket.close).toHaveBeenCalledOnce(); expect(socket.onmessage).toBeUndefined();
    expect(receipt()).toMatchObject({ routeKind: 'loopback_direct', localTransport: 'closed' });
    startFailure = null;
    const retry = await sender(); await retry.start();
    await expect(retry.pushChunk(new Uint8Array([4, 5, 6]))).resolves.toMatchObject([{ text: 'hel' }]);
    await expect(retry.finish()).resolves.toMatchObject({ finalText: 'hello' });
    expect(receivedPcm).toEqual([new Uint8Array([4, 5, 6])]);
    expect(opens[0]).not.toHaveProperty('maxDurationMs');
    expect(network.requests.some(request => request.method.endsWith('.chunk'))).toBe(false);
  });
  it('preserves rejected direct start and retirement when native close itself throws', async () => {
    const stream = await sender(); startFailure = 'throw'; closeFailure = true;
    await expect(stream.start()).rejects.toThrow('daemon_start_failed');
    expect(NativeWebSocket.instances[0]!.onmessage).toBeUndefined();
    expect(receipt()).toMatchObject({ localTransport: 'closed' });
  });
  it('keeps daemon finish failure distinct from successful local retirement', async () => {
    const stream = await sender(); await stream.start(); finishFailure = true;
    await expect(stream.finish()).rejects.toMatchObject({ code: 'runtime_unavailable' });
    expect(receipt()).toMatchObject({ localTransport: 'closed', operation: { kind: 'finish', result: 'error' } });
  });
  it('keeps daemon cancel failure distinct from successful local retirement', async () => {
    const stream = await sender(); await stream.start(); cancelFailure = true;
    await stream.cancel();
    expect(receipt()).toMatchObject({ localTransport: 'closed', operation: { kind: 'cancel', result: 'error' } });
  });
  it('uses the actual machine TCP preference to skip the direct Voice grant', async () => {
    storage.getState().applySettingsLocal({ peerMediationPreferencesV1: {
      v: 1, flows: { tcp_tunnel: { direct: 'disabled' } }, byMachineId: {},
    } });
    relay = false; publishFeatures();
    expect((await sender()).transportKind).toBe('json_rpc_compat');
    expect(grants).toEqual([]); expect(NativeWebSocket.instances).toEqual([]);
  });
  it.each(['secret', 'data-key'] as const)('uses current ephemeral V2 direct proofs independently of %s credentials', async credentialKind => {
    expect(credentialKind === 'secret' ? 'secret' in account.credentials : 'encryption' in account.credentials).toBe(true);
    expect(await TokenStorage.getCredentialsForServerUrl(HOME, { serverId: account.home.id })).toEqual(account.credentials);
    const accountStorage = await resolveAccountStorageContext(account.credentials);
    expect(accountStorage.mode).toBe('e2ee');
    expect(accountStorage.encryption).not.toBeNull();
    const tunnel = await openProductionVoiceMediaTunnel({ machineTarget: { machineId: 'machine-1' },
      requestId: 'request-1', signal: null, authority: { applicationKind: 'speech_transcription', applicationAttemptId: 'request-1',
        applicationAuthorityDigest: createSpeechTranscriptionApplicationAuthorityDigestV1('request-1') } });
    expect(tunnel?.routeKind).toBe('loopback_direct');
    await tunnel?.close();
    expect(opens[0]).toMatchObject({ v: 2, routeKind: 'loopback_direct', proof: { kind: 'ephemeral_ed25519' } });
    expect(grants).toHaveLength(1);
  });
  it('returns compatibility without native admission when the machine has no daemon endpoint port', async () => {
    selectMachine(true, null);
    expect((await sender()).transportKind).toBe('json_rpc_compat');
    expect(grants).toEqual([]);
  });
  it('returns compatibility without native admission when target Home credentials are unavailable', async () => {
    expect(await TokenStorage.removeCredentialsForServerUrl(HOME, { serverId: account.home.id })).toBe(true);
    await expect(openProductionVoiceMediaTunnel({ machineTarget: { machineId: 'machine-1' }, requestId: 'request-1',
      signal: null, authority: { applicationKind: 'speech_transcription', applicationAttemptId: 'request-1',
        applicationAuthorityDigest: createSpeechTranscriptionApplicationAuthorityDigestV1('request-1') } })).resolves.toBeNull();
    expect(grants).toEqual([]); expect(NativeWebSocket.instances).toEqual([]);
  });
  it.each([{}, { maxDurationMs: 60_000, maxTotalBytes: 960_000 }])('authenticates relay PCM/final and closes failed installation before retry with caps %j', async caps => {
    direct = false; applicationCaps = caps; publishFeatures(); selectMachine(false);
    const stream = await sender(); expect(stream.transportKind).toBe('binary_tunnel'); await stream.start();
    await stream.pushChunk(new Uint8Array([4, 5, 6]));
    await expect(stream.finish()).resolves.toMatchObject({ finalText: 'hello' });
    expect(receivedPcm).toEqual([new Uint8Array([4, 5, 6])]);
    expect(receipt()).toMatchObject({ relayEvidence: 'finish_authenticated', localTransport: 'closed' });
    expect(grants[0]).toMatchObject({ scope: caps });
    expect((grants[0] as { scope: unknown }).scope).not.toHaveProperty('maxIdleMs');
    confirmation = 'invalid-confirmation'; installedKey = null;
    const failed = await sender(); await expect(failed.start()).rejects.toMatchObject({ code: 'internal_error' });
    expect(receipt()).toMatchObject({ relayEvidence: 'pending', localTransport: 'closed' });
    expect(network.requests.some(request => request.method.endsWith('.cancel'))).toBe(true);
    confirmation = PEER_APPLICATION_ENCRYPTION_INSTALL_CONFIRMATION_V1; installedKey = null;
    const retry = await sender(); await retry.start(); await retry.finish();
    expect(receipt()).toMatchObject({ localTransport: 'closed' });
  });
  it('fails closed before Socket/grant admission when relay mint V2 is not advertised', async () => {
    direct = false; mintVersions = []; publishFeatures();
    expect((await sender()).transportKind).toBe('json_rpc_compat'); expect(grants).toEqual([]);
  });
  it('keeps native relay close failure distinct from the rejected daemon start', async () => {
    direct = false; publishFeatures(); selectMachine(false);
    const stream = await sender(); startFailure = 'throw'; closeFailure = true;
    await expect(stream.start()).rejects.toThrow('daemon_start_failed');
    expect(receipt()).toMatchObject({ routeKind: 'server_relay', localTransport: 'close_failed' });
  });
  it('fails closed to compatibility when the actual V2 grant mint is unavailable', async () => {
    grantFailure = true; relay = false; publishFeatures();
    expect((await sender()).transportKind).toBe('json_rpc_compat');
    expect(NativeWebSocket.instances).toEqual([]); expect(network.requests).toEqual([]);
  });
  it('uses compatibility when physical relay Socket connection is unavailable', async () => {
    direct = false; publishFeatures();
    // A native connection with no assigned Socket id cannot receive a socket-
    // bound relay grant. Exercise that physical ABI instead of replacing its owner.
    physicalSockets.forEach(boundary => { boundary.socket.id = ''; });
    network.setSocketConfigurator(boundary => { boundary.socket.id = ''; });
    expect((await sender()).transportKind).toBe('json_rpc_compat');
  });
});
afterAll(() => network.dispose());

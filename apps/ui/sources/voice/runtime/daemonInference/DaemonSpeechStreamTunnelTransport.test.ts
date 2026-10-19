import {
  decodePeerTcpTunnelBinaryFrameV2,
  encodePeerTcpTunnelBinaryFrameV2,
  PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
  PEER_APPLICATION_ENCRYPTION_INSTALL_CONFIRMATION_V1,
  createPeerApplicationEncryptionAadV1,
  createPeerApplicationEncryptionNonceV1,
  createSpeechTranscriptionApplicationAuthorityDigestV1,
  decodeBase64 as decodeProtocolBase64,
  decodePeerApplicationEncryptedFrameV1,
  deriveBoxPublicKeyFromSeed,
  encodeBase64 as encodeProtocolBase64,
  encodePeerApplicationEncryptedFrameV1,
  openEncryptedDataKeyEnvelopeV1,
  type DaemonVoiceInferenceSttStreamStartRequest,
  type PeerTcpTunnelOpenResponseV1,
  type PeerTcpTunnelOpenV1,
} from '@happier-dev/protocol';
import type { PeerTcpTunnelFrame } from '@happier-dev/peer-transport/duplexFrames';
import { describe, expect, it, vi } from 'vitest';

import { encodeBase64 } from '@/encryption/base64';
import { openAes256GcmBytes, sealAes256GcmBytes } from '@/encryption/aes256GcmBytes';

import {
  createDaemonSpeechStreamCarrierAdapter,
  describeDaemonSpeechStreamRpcCompatibilityTransport,
} from './DaemonSpeechStreamCarrier';
import type { DaemonSpeechStreamTransportChunkRequest } from './DaemonSpeechStreamSender';

type DynamicModule = Record<string, unknown>;
type TestWebSocket = {
  binaryType?: string;
  sent: unknown[];
  onopen?: () => void;
  send: (payload: unknown) => void;
  close: () => void;
};
type TestStream = Readonly<{
  sendFrame: (frame: PeerTcpTunnelFrame) => Promise<void> | void;
  close: () => Promise<void> | void;
}>;

async function loadModule(path: string): Promise<DynamicModule> {
  return import(path).catch((importError: unknown) => ({ importError }));
}

function createWebSocketFixture() {
  let socket: TestWebSocket | null = null;
  const getSocket = (): TestWebSocket => {
    if (!socket) throw new Error('expected websocket fixture');
    return socket;
  };
  const WebSocketCtor = vi.fn(() => {
    socket = {
      sent: [],
      send(payload: unknown) {
        this.sent.push(payload);
      },
      close: vi.fn(),
    };
    return getSocket();
  });
  return { getSocket, WebSocketCtor };
}

const open: PeerTcpTunnelOpenV1 = {
  v: 1,
  kind: 'open',
  tunnelId: 'tun_voice',
  targetMachineId: 'machine_1',
  routeKind: 'loopback_direct',
  destination: { host: '127.0.0.1', port: 3000 },
  selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
};

const response: PeerTcpTunnelOpenResponseV1 = {
  v: 1,
  tunnelId: 'tun_voice',
  streamPath: '/peer-mediation/v1/tunnel/stream',
  encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
  initialWindowBytes: 1024,
  maxFrameBytes: 1024,
};

describe('negotiated PCM packet budget', () => {
  it.each([false, true])('accounts for encrypted=%s framing at the strict consumer boundary', async encrypted => {
    const { createDaemonSpeechStreamTunnelTransport } = await import('./DaemonSpeechStreamTunnelTransport');
    const transport = createDaemonSpeechStreamTunnelTransport({
      tunnelId: 'budget', maxFrameBytes: 1024,
      stream: { sendFrame: vi.fn(), sendSubstreamDataFrame: vi.fn(), sendSubstreamFrame: vi.fn(), onSubstreamFrame: () => () => {} },
      controlTransport: { start: vi.fn(), finish: vi.fn(), cancel: vi.fn() },
      ...(encrypted ? { peerApplicationEncryption: {
        v: 1, suite: 'aes-256-gcm', flowKind: 'voice_media', routeKind: 'server_relay',
        authorityDigest: 'sha256:' + 'a'.repeat(64), accountId: 'account', machineId: 'machine', tunnelId: 'budget',
        applicationKind: 'speech_transcription', applicationAttemptId: 'attempt',
        applicationAuthorityDigest: createSpeechTranscriptionApplicationAuthorityDigestV1('attempt'),
      } as const } : {}),
    });
    const budget = transport.maxPcm16ChunkBytes;
    expect(budget).toBeGreaterThan(0);
    if (budget === undefined) throw new Error('missing negotiated PCM budget');
    const frameLength = (bytes: number) => encrypted ? encodePeerApplicationEncryptedFrameV1({
      v: 1, kind: 'data', nonceBase64Url: encodeProtocolBase64(new Uint8Array(12), 'base64url'),
      ciphertextBase64Url: encodeProtocolBase64(new Uint8Array(bytes + 16), 'base64url'),
    }).byteLength : bytes;
    expect(budget % 2).toBe(0);
    expect(frameLength(budget)).toBeLessThanOrEqual(1024);
    expect(frameLength(budget + 2)).toBeGreaterThan(1024);
    for (const pcmBytes of [0, 2, 4, budget]) {
      expect(transport.measureInFlightChunkBytes?.(pcmBytes)).toBe(frameLength(pcmBytes));
    }
  });
});

function startResponse(payload: DaemonVoiceInferenceSttStreamStartRequest) {
  return {
    ok: true as const,
    requestId: payload.requestId,
    streamId: 'stream-1',
    generation: 3,
    ackSeq: -1,
    format: payload.format,
  };
}

describe('DaemonSpeechStreamTunnelTransport', () => {
  it('observes a tunnel-level abort during encrypted installation without waiting for a substream timeout', async () => {
    const { createDaemonSpeechStreamTunnelTransport } = await import('./DaemonSpeechStreamTunnelTransport');
    const { openPeerTcpTunnelRelayStream } = await import('@/sync/domains/machines/peer/mediation/tunnel/relayStream');
    const { PeerTcpTunnelRelayEnvelopeSchema } = await import('@happier-dev/protocol');
    let receive!: (envelope: unknown) => void;
    const relay = await openPeerTcpTunnelRelayStream({
      scopeUserId: 'account-1', relaySocketId: 'socket-1',
      open: { ...open, routeKind: 'server_relay' },
      onEnvelope: handler => { receive = value => handler(PeerTcpTunnelRelayEnvelopeSchema.parse(value)); return () => undefined; },
      send: (_event, envelope) => {
        if (envelope.v === 2) receive({
          v: 1, scopeUserId: 'account-1', sender: { kind: 'machine', machineId: 'machine_1' }, recipient: { kind: 'user' },
          frame: { v: 1, kind: 'abort', tunnelId: open.tunnelId, reasonCode: 'relay_authorization_invalid' },
        });
      },
    });
    const failure = vi.fn();
    const cancel = vi.fn(async () => ({ ok: true as const, streamId: 'stream-1', generation: 3 }));
    const transport = createDaemonSpeechStreamTunnelTransport({
      tunnelId: open.tunnelId, stream: relay, responseTimeoutMs: 50,
      peerApplicationEncryption: {
        v: 1, suite: 'aes-256-gcm', flowKind: 'voice_media', routeKind: 'server_relay',
        authorityDigest: `sha256:${'ab'.repeat(32)}`, accountId: 'account-1', machineId: 'machine_1', tunnelId: open.tunnelId,
        applicationKind: 'speech_transcription', applicationAttemptId: 'request-1',
        applicationAuthorityDigest: createSpeechTranscriptionApplicationAuthorityDigestV1('request-1'),
      },
      onRelayEncryptionFailure: failure,
      controlTransport: {
        start: async payload => ({ ...startResponse(payload), peerApplicationEncryption: {
          v: 1, suite: 'aes-256-gcm', recipientPublicKeyBase64Url: encodeProtocolBase64(deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(9)), 'base64url'),
        } }),
        finish: async () => { throw new Error('unused finish'); }, cancel,
      },
    });
    await expect(transport.start({ requestId: 'request-1', packId: null, language: null, format: {
      sampleRateHz: 16_000, channelCount: 1, bitsPerSample: 16, ffmpegCodec: 'pcm_s16le',
    } })).resolves.toMatchObject({ ok: false, errorCode: 'internal_error' });
    expect(failure).toHaveBeenCalledWith({ step: 'confirmation_wait', reason: 'aborted' });
    expect(cancel).toHaveBeenCalledWith({ streamId: 'stream-1', generation: 3 });
    await relay.close();
  });

  it('forwards the streaming mode selected by the live sender contract', async () => {
    const transportMod = await loadModule('./DaemonSpeechStreamTunnelTransport');
    const createTransport = transportMod.createDaemonSpeechStreamTunnelTransport;
    expect(createTransport).toBeTypeOf('function');
    if (typeof createTransport !== 'function') return;

    const start = vi.fn(async (payload: DaemonVoiceInferenceSttStreamStartRequest) => startResponse(payload));
    const transport = createTransport({
      tunnelId: 'tun_voice',
      stream: {
        sendFrame: vi.fn(),
        sendSubstreamDataFrame: vi.fn(),
        close: vi.fn(),
      },
      controlTransport: {
        start,
        finish: vi.fn(),
        cancel: vi.fn(),
      },
    });

    await transport.start({
      requestId: 'request-1',
      packId: 'stt-pack-1',
      language: 'en',
      streamingMode: 'upload_bridge',
      format: {
        sampleRateHz: 16_000,
        channelCount: 1,
        bitsPerSample: 16,
        ffmpegCodec: 'pcm_s16le',
      },
    });

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'request-1',
      streamingMode: 'upload_bridge',
    }));
  });

  it.each(['healthy', 'send', 'open', 'parse'] as const)('installs real relay envelopes and retains private %s failures', async failureStage => {
    const { createDaemonSpeechStreamTunnelTransport: createTransport } = await import('./DaemonSpeechStreamTunnelTransport');
    const binding = {
      v: 1 as const,
      suite: 'aes-256-gcm' as const,
      flowKind: 'voice_media' as const,
      routeKind: 'server_relay' as const,
      authorityDigest: 'sha256:acdb52b3d7de70428b1c54fbb340ab675b98d6900d2b86ababad20baa7aed6ca',
      accountId: 'account-1',
      machineId: 'machine-1',
      tunnelId: 'tun_voice',
      applicationKind: 'speech_transcription' as const,
      applicationAttemptId: 'request-1',
      applicationAuthorityDigest:
        createSpeechTranscriptionApplicationAuthorityDigestV1('request-1'),
    };
    const recipientSecretKeySeed = new Uint8Array(32).fill(9);
    const recipientPublicKeyBase64Url = encodeProtocolBase64(
      deriveBoxPublicKeyFromSeed(recipientSecretKeySeed),
      'base64url',
    );
    let handler: ((event: any) => void) | null = null;
    let installedKey: Uint8Array | null = null;
    let sendError: unknown = null;
    const sentPayloads: Uint8Array[] = [];
    const networkFailure = new Error('network boundary refused data');
    const onRelayAuthenticatedEvidence = vi.fn();
    const sendSubstreamDataFrame = vi.fn(async (substreamId: string, outbound: any) => {
      try {
      sentPayloads.push(new Uint8Array(outbound.payloadBytes));
      const encrypted = decodePeerApplicationEncryptedFrameV1(outbound.payloadBytes);
      if (!encrypted) throw new Error('expected encrypted frame');
      if (encrypted.kind === 'data' && failureStage === 'send') throw networkFailure;
      if (encrypted.kind === 'install') {
        installedKey = openEncryptedDataKeyEnvelopeV1({
          envelope: decodeProtocolBase64(encrypted.encryptedDataKeyEnvelopeBase64Url!, 'base64url'),
          recipientSecretKeyOrSeed: recipientSecretKeySeed,
        });
      }
      if (!installedKey) throw new Error('expected installed key');
      const requestNonce = createPeerApplicationEncryptionNonceV1({
        direction: 'client_to_daemon', phase: encrypted.kind, sequence: outbound.sequence,
      });
      const requestPlaintext = await openAes256GcmBytes({
        key: installedKey,
        nonce: requestNonce,
        aad: createPeerApplicationEncryptionAadV1({
          authorityDigest: binding.authorityDigest,
          accountId: binding.accountId,
          machineId: binding.machineId,
          tunnelId: binding.tunnelId,
          applicationKind: binding.applicationKind,
          applicationAttemptId: binding.applicationAttemptId,
          applicationAuthorityDigest: binding.applicationAuthorityDigest,
          direction: 'client_to_daemon',
          streamId: 'stream-1', generation: 3, substreamId,
          sequence: outbound.sequence, phase: encrypted.kind,
        }),
        ciphertext: decodeProtocolBase64(encrypted.ciphertextBase64Url, 'base64url'),
      });
      if (encrypted.kind === 'data') expect([...requestPlaintext]).toEqual([0, 0, 1, 0]);
      const responsePlaintext = encrypted.kind === 'data' && failureStage === 'parse'
        ? new TextEncoder().encode(JSON.stringify({ ok: true, unexpected: true }))
        : encrypted.kind === 'install'
        ? new TextEncoder().encode(PEER_APPLICATION_ENCRYPTION_INSTALL_CONFIRMATION_V1)
        : encrypted.kind === 'finish'
          ? new TextEncoder().encode(JSON.stringify({
              ok: true, streamId: 'stream-1', generation: 3, ackSeq: 0,
              finalText: 'hello', language: 'en', modelPackId: 'stt-pack-1', events: [],
            }))
          : new TextEncoder().encode(JSON.stringify({
              ok: true, streamId: 'stream-1', generation: 3, ackSeq: 0, events: [],
            }));
      const responseNonce = createPeerApplicationEncryptionNonceV1({
        direction: 'daemon_to_client', phase: encrypted.kind, sequence: outbound.sequence,
      });
      const responseCiphertext = await sealAes256GcmBytes({
        key: installedKey,
        nonce: responseNonce,
        aad: createPeerApplicationEncryptionAadV1({
          authorityDigest: binding.authorityDigest,
          accountId: binding.accountId,
          machineId: binding.machineId,
          tunnelId: binding.tunnelId,
          applicationKind: binding.applicationKind,
          applicationAttemptId: binding.applicationAttemptId,
          applicationAuthorityDigest: binding.applicationAuthorityDigest,
          direction: 'daemon_to_client',
          streamId: 'stream-1', generation: 3, substreamId,
          sequence: outbound.sequence, phase: encrypted.kind,
        }),
        plaintext: responsePlaintext,
      });
      if (encrypted.kind === 'data' && failureStage === 'open') responseCiphertext[0] ^= 1;
      handler?.({
        substreamId,
        frame: {
          v: 1, kind: 'data', tunnelId: 'tun_voice', direction: 'daemon_to_client',
          sequence: outbound.sequence,
          payload: encodePeerApplicationEncryptedFrameV1({
            v: 1,
            kind: encrypted.kind,
            nonceBase64Url: encodeProtocolBase64(responseNonce, 'base64url'),
            ciphertextBase64Url: encodeProtocolBase64(responseCiphertext, 'base64url'),
          }),
        },
      });
      } catch (error) {
        sendError = error;
        throw error;
      }
    });
    const transport = createTransport({
      tunnelId: 'tun_voice',
      peerApplicationEncryption: binding,
      stream: {
        sendFrame: vi.fn(),
        sendSubstreamDataFrame,
        onSubstreamFrame: vi.fn((next) => { handler = next; return () => { handler = null; }; }),
      },
      onRelayAuthenticatedEvidence,
      controlTransport: {
        start: vi.fn(async (payload: DaemonVoiceInferenceSttStreamStartRequest) => ({
          ...startResponse(payload),
          peerApplicationEncryption: { v: 1 as const, suite: 'aes-256-gcm' as const, recipientPublicKeyBase64Url },
        })),
        finish: vi.fn(),
        cancel: vi.fn(async () => ({ ok: true as const, streamId: 'stream-1', generation: 3 })),
      },
    });
    const startResult = await transport.start({
      requestId: 'request-encrypted',
      packId: null,
      language: null,
      streamingMode: 'runtime',
      format: { sampleRateHz: 16_000, channelCount: 1, bitsPerSample: 16, ffmpegCodec: 'pcm_s16le' },
    });
    expect(sendError).toBeNull();
    expect(startResult).toMatchObject({ ok: true, peerApplicationEncryption: { suite: 'aes-256-gcm' } });
    expect(onRelayAuthenticatedEvidence).toHaveBeenLastCalledWith({ phase: 'install' });
    const carrierFrame = createDaemonSpeechStreamCarrierAdapter({ routeKind: 'server_relay', binaryCapable: true })
      .encodeInputAppendFrame({ streamId: 'stream-1', generation: 3, seq: 0, pcm16Bytes: new Uint8Array([0, 0, 1, 0]) });
    const chunk = await transport.chunk({
      streamId: 'stream-1', generation: 3, seq: 0, carrierFrame, compatibilityTransport: null,
    });
    if (failureStage !== 'healthy') {
      expect(chunk).toMatchObject({ ok: false, error: 'daemon_voice_inference_relay_encryption_failed', errorCode: 'internal_error' });
      const cause = Object.getOwnPropertyDescriptor(chunk, 'cause');
      expect(cause?.enumerable).toBe(false);
      expect(cause?.value).toBeInstanceOf(Error);
      expect(cause?.value.message).toBe(`daemon_voice_inference_relay_${failureStage}_failed`);
      expect(cause?.value.cause).toBeInstanceOf(Error);
      if (failureStage === 'send') expect(cause?.value.cause).toBe(networkFailure);
      expect(JSON.stringify(chunk)).not.toContain('cause');
      await transport.cancel({ streamId: 'stream-1', generation: 3 });
      return;
    }
    expect(chunk).toMatchObject({ ok: true, ackSeq: 0 });
    expect(onRelayAuthenticatedEvidence).toHaveBeenLastCalledWith({ phase: 'data', ackSeq: 0 });
    expect(sentPayloads).toHaveLength(2);
    expect([...sentPayloads[1]!]).not.toEqual([0, 0, 1, 0]);
    expect(new TextDecoder().decode(sentPayloads[1]!)).not.toContain('AAAAAQ');
    await expect(transport.finish({ streamId: 'stream-1', generation: 3, finalSeq: 0 }))
      .resolves.toMatchObject({ ok: true, finalText: 'hello' });
    expect(onRelayAuthenticatedEvidence).toHaveBeenLastCalledWith({ phase: 'finish', ackSeq: 0 });
    expect(onRelayAuthenticatedEvidence).toHaveBeenCalledTimes(3);
    expect(sentPayloads).toHaveLength(3);
  });

  it('fails closed before sending PCM when the binary substream has no response owner', async () => {
    const transportMod = await loadModule('./DaemonSpeechStreamTunnelTransport');
    const createTransport = transportMod.createDaemonSpeechStreamTunnelTransport;
    expect(createTransport).toBeTypeOf('function');
    if (typeof createTransport !== 'function') return;

    const sendSubstreamDataFrame = vi.fn();
    const sendSubstreamFrame = vi.fn();
    const compatibilityChunk = vi.fn();
    const transport = createTransport({
      tunnelId: 'tun_voice',
      stream: {
        sendFrame: vi.fn(),
        sendSubstreamDataFrame,
        sendSubstreamFrame,
        close: vi.fn(),
      },
      controlTransport: {
        start: async (payload: DaemonVoiceInferenceSttStreamStartRequest) => startResponse(payload),
        finish: async (payload: { streamId: string; generation: number; finalSeq: number }) => ({
          ok: true as const,
          streamId: payload.streamId,
          generation: payload.generation,
          ackSeq: payload.finalSeq,
          finalText: '',
          language: null,
          modelPackId: null,
          events: [],
        }),
        cancel: async (payload: { streamId: string; generation: number }) => ({
          ok: true as const,
          streamId: payload.streamId,
          generation: payload.generation,
        }),
      },
      fallbackTransport: { chunk: compatibilityChunk },
    });
    const adapter = createDaemonSpeechStreamCarrierAdapter({
      routeKind: 'loopback_direct',
      binaryCapable: true,
    });
    const pcmBytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const carrierFrame = adapter.encodeInputAppendFrame({
      streamId: 'stream-1',
      generation: 3,
      seq: 5,
      pcm16Bytes: pcmBytes,
    });

    await expect(transport.chunk({
      streamId: 'stream-1',
      generation: 3,
      seq: 5,
      carrierFrame,
      compatibilityTransport: null,
    })).resolves.toEqual({
      ok: false,
      error: 'daemon_voice_inference_substream_response_unavailable',
      errorCode: 'internal_error',
    });

    expect(sendSubstreamDataFrame).not.toHaveBeenCalled();
    expect(sendSubstreamFrame).not.toHaveBeenCalled();
    expect(compatibilityChunk).not.toHaveBeenCalled();
  });

  it('rejects a matching application-substream abort immediately instead of waiting for response timeout', async () => {
    const transportMod = await loadModule('./DaemonSpeechStreamTunnelTransport');
    const createTransport = transportMod.createDaemonSpeechStreamTunnelTransport;
    expect(createTransport).toBeTypeOf('function');
    if (typeof createTransport !== 'function') return;

    let substreamHandler: ((event: Readonly<{
      substreamId: string;
      frame: import('@happier-dev/peer-transport/duplexFrames').PeerTcpTunnelFrame;
    }>) => void) | null = null;
    const transport = createTransport({
      tunnelId: 'tun_voice',
      stream: {
        sendFrame: vi.fn(),
        sendSubstreamDataFrame: vi.fn(async () => {
          queueMicrotask(() => substreamHandler?.({
            substreamId: 'daemon.voiceInference.stt.stream-1.3',
            frame: {
              v: 1,
              kind: 'abort',
              tunnelId: 'tun_voice',
              reasonCode: 'application_dispatch_failed',
            },
          }));
        }),
        onSubstreamFrame: (handler: typeof substreamHandler) => {
          substreamHandler = handler;
          return () => { substreamHandler = null; };
        },
      },
      controlTransport: {
        start: async (payload: DaemonVoiceInferenceSttStreamStartRequest) => startResponse(payload),
        finish: vi.fn(),
        cancel: vi.fn(),
      },
      responseTimeoutMs: 5_000,
    });
    const carrierFrame = createDaemonSpeechStreamCarrierAdapter({
      routeKind: 'loopback_direct',
      binaryCapable: true,
    }).encodeInputAppendFrame({
      streamId: 'stream-1',
      generation: 3,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0]),
    });

    await expect(transport.chunk({
      streamId: 'stream-1',
      generation: 3,
      seq: 0,
      carrierFrame,
      compatibilityTransport: null,
    })).rejects.toThrow('daemon_voice_inference_substream_aborted:application_dispatch_failed');
  });

  it('resolves binary substream chunks with daemon-to-client partial and endpoint events', async () => {
    const transportMod = await loadModule('./DaemonSpeechStreamTunnelTransport');
    const createTransport = transportMod.createDaemonSpeechStreamTunnelTransport;
    expect(createTransport).toBeTypeOf('function');
    if (typeof createTransport !== 'function') return;

    let substreamHandler: ((event: Readonly<{
      substreamId: string;
      frame: PeerTcpTunnelFrame;
    }>) => void) | null = null;
    const sendSubstreamDataFrame = vi.fn(async () => {
      queueMicrotask(() => {
        const response = {
          ok: true,
          streamId: 'stream-1',
          generation: 3,
          ackSeq: 5,
          events: [
            { type: 'partial', seq: 5, text: 'hel', isEndpoint: false, confidence: null },
            { type: 'endpoint', seq: 5, transcript: 'hello', reason: 'vad' },
          ],
        };
        substreamHandler?.({
          substreamId: 'daemon.voiceInference.stt.stream-1.3',
          frame: {
            v: 1,
            kind: 'data',
            tunnelId: 'tun_voice',
            direction: 'daemon_to_client',
            sequence: 5,
            payload: new TextEncoder().encode(JSON.stringify(response)),
          },
        });
      });
    });
    const transport = createTransport({
      tunnelId: 'tun_voice',
      stream: {
        sendFrame: vi.fn(),
        sendSubstreamDataFrame,
        sendSubstreamFrame: vi.fn(),
        onSubstreamFrame: (handler: typeof substreamHandler) => {
          substreamHandler = handler;
          return () => {
            if (substreamHandler === handler) substreamHandler = null;
          };
        },
        close: vi.fn(),
      },
      controlTransport: {
        start: async (payload: DaemonVoiceInferenceSttStreamStartRequest) => startResponse(payload),
        finish: async (payload: { streamId: string; generation: number; finalSeq: number }) => ({
          ok: true as const,
          streamId: payload.streamId,
          generation: payload.generation,
          ackSeq: payload.finalSeq,
          finalText: '',
          language: null,
          modelPackId: null,
          events: [],
        }),
        cancel: async (payload: { streamId: string; generation: number }) => ({
          ok: true as const,
          streamId: payload.streamId,
          generation: payload.generation,
        }),
      },
    });
    const adapter = createDaemonSpeechStreamCarrierAdapter({
      routeKind: 'loopback_direct',
      binaryCapable: true,
    });
    const carrierFrame = adapter.encodeInputAppendFrame({
      streamId: 'stream-1',
      generation: 3,
      seq: 5,
      pcm16Bytes: new Uint8Array([1, 2, 3, 4]),
    });

    await expect(transport.chunk({
      streamId: 'stream-1',
      generation: 3,
      seq: 5,
      carrierFrame,
      compatibilityTransport: null,
    })).resolves.toEqual({
      ok: true,
      streamId: 'stream-1',
      generation: 3,
      ackSeq: 5,
      events: [
        { type: 'partial', seq: 5, text: 'hel', isEndpoint: false, confidence: null },
        { type: 'endpoint', seq: 5, transcript: 'hello', reason: 'vad' },
      ],
    });

    expect(sendSubstreamDataFrame).toHaveBeenCalledTimes(1);
  });

  it('appends a binary carrier frame through the peer TCP tunnel owner without invoking compatibility chunk RPC', async () => {
    const tunnelMod = await loadModule('@/sync/domains/machines/peer/mediation/tunnel');
    const transportMod = await loadModule('./DaemonSpeechStreamTunnelTransport');
    const openLoopbackStream = tunnelMod.openPeerTcpTunnelLoopbackStream;
    const createTransport = transportMod.createDaemonSpeechStreamTunnelTransport;
    expect(openLoopbackStream).toBeTypeOf('function');
    expect(createTransport).toBeTypeOf('function');
    if (typeof openLoopbackStream !== 'function' || typeof createTransport !== 'function') return;

    const { getSocket, WebSocketCtor } = createWebSocketFixture();
    const streamPromise = openLoopbackStream({
      endpointUrl: 'http://127.0.0.1:1234/base',
      open,
      response,
      WebSocketCtor,
    }) as Promise<TestStream>;
    getSocket().onopen?.();
    const stream = await streamPromise;
    const compatibilityChunk = vi.fn();
    const transport = createTransport({
      tunnelId: 'tun_voice',
      stream,
      controlTransport: {
        start: async (payload: DaemonVoiceInferenceSttStreamStartRequest) => startResponse(payload),
        finish: async (payload: { streamId: string; generation: number; finalSeq: number }) => ({
          ok: true as const,
          streamId: payload.streamId,
          generation: payload.generation,
          ackSeq: payload.finalSeq,
          finalText: '',
          language: null,
          modelPackId: null,
          events: [],
        }),
        cancel: async (payload: { streamId: string; generation: number }) => ({
          ok: true as const,
          streamId: payload.streamId,
          generation: payload.generation,
        }),
      },
      fallbackTransport: { chunk: compatibilityChunk },
    });
    const adapter = createDaemonSpeechStreamCarrierAdapter({
      routeKind: 'loopback_direct',
      binaryCapable: true,
    });
    const pcmBytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const carrierFrame = adapter.encodeInputAppendFrame({
      streamId: 'stream-1',
      generation: 3,
      seq: 5,
      pcm16Bytes: pcmBytes,
    });

    const chunkResult = transport.chunk({
      streamId: 'stream-1',
      generation: 3,
      seq: 5,
      carrierFrame,
      compatibilityTransport: null,
    });

    await vi.waitFor(() => expect(getSocket().sent.length).toBe(1));
    const responsePayload = new TextEncoder().encode(JSON.stringify({
      ok: true,
      streamId: 'stream-1',
      generation: 3,
      ackSeq: 5,
      events: [],
    }));
    (getSocket() as unknown as { onmessage?: (event: { data: Uint8Array }) => void }).onmessage?.({
      data: encodePeerTcpTunnelBinaryFrameV2({
        header: {
          version: 2,
          kind: 'data',
          tunnelId: 'tun_voice',
          substreamId: 'daemon.voiceInference.stt.stream-1.3',
          direction: 'daemon_to_client',
          sequence: 5,
          payloadLength: responsePayload.byteLength,
        },
        payload: responsePayload,
      }),
    });

    await expect(chunkResult).resolves.toEqual({
      ok: true,
      streamId: 'stream-1',
      generation: 3,
      ackSeq: 5,
      events: [],
    });

    expect(compatibilityChunk).not.toHaveBeenCalled();
    const sent = getSocket().sent[0];
    expect(sent).toBeInstanceOf(Uint8Array);
    const decoded = decodePeerTcpTunnelBinaryFrameV2({
      frame: sent as Uint8Array,
      maxHeaderBytes: 1024,
      maxPayloadBytes: 1024,
    });
    expect(decoded).toMatchObject({
      ok: true,
      header: {
        version: 2,
        kind: 'data',
        tunnelId: 'tun_voice',
        substreamId: 'daemon.voiceInference.stt.stream-1.3',
        direction: 'client_to_daemon',
        sequence: 5,
        payloadLength: pcmBytes.byteLength,
      },
    });
    expect(decoded.ok ? [...decoded.payload] : []).toEqual([...pcmBytes]);
  });

  it('keeps JSON/base64 fallback explicit when a tunnel binary frame is not selected', async () => {
    const transportMod = await loadModule('./DaemonSpeechStreamTunnelTransport');
    const createTransport = transportMod.createDaemonSpeechStreamTunnelTransport;
    expect(createTransport).toBeTypeOf('function');
    if (typeof createTransport !== 'function') return;

    const sendFrame = vi.fn();
    const fallbackChunk = vi.fn(async (payload: DaemonSpeechStreamTransportChunkRequest) => ({
      ok: true as const,
      streamId: payload.streamId,
      generation: payload.generation,
      ackSeq: payload.seq,
      events: [],
    }));
    const transport = createTransport({
      tunnelId: 'tun_voice',
      stream: { sendFrame, close: vi.fn() },
      controlTransport: {
        start: async (payload: DaemonVoiceInferenceSttStreamStartRequest) => startResponse(payload),
        finish: async (payload: { streamId: string; generation: number; finalSeq: number }) => ({
          ok: true as const,
          streamId: payload.streamId,
          generation: payload.generation,
          ackSeq: payload.finalSeq,
          finalText: '',
          language: null,
          modelPackId: null,
          events: [],
        }),
        cancel: async (payload: { streamId: string; generation: number }) => ({
          ok: true as const,
          streamId: payload.streamId,
          generation: payload.generation,
        }),
      },
      fallbackTransport: { chunk: fallbackChunk },
    });
    const adapter = createDaemonSpeechStreamCarrierAdapter({
      routeKind: 'loopback_direct',
      binaryCapable: false,
    });
    const carrierFrame = adapter.encodeInputAppendFrame({
      streamId: 'stream-1',
      generation: 3,
      seq: 5,
      pcm16Bytes: new Uint8Array([1, 2, 3, 4]),
    });

    await expect(transport.chunk({
      streamId: 'stream-1',
      generation: 3,
      seq: 5,
      carrierFrame,
      compatibilityTransport: describeDaemonSpeechStreamRpcCompatibilityTransport(),
    })).resolves.toMatchObject({
      ok: true,
      streamId: 'stream-1',
      generation: 3,
      ackSeq: 5,
    });

    expect(sendFrame).not.toHaveBeenCalled();
    expect(fallbackChunk).toHaveBeenCalledWith(expect.objectContaining({
      carrierFrame: expect.objectContaining({
        kind: 'machine_rpc_json_base64',
        jsonBase64Envelope: { pcm16Base64: 'AQIDBA==' },
      }),
      compatibilityTransport: expect.objectContaining({
        kind: 'machine_rpc_json_base64_compatibility',
      }),
    }));
  });

  it('fails closed for binary frames when the tunnel stream cannot append a bound substream frame', async () => {
    const transportMod = await loadModule('./DaemonSpeechStreamTunnelTransport');
    const createTransport = transportMod.createDaemonSpeechStreamTunnelTransport;
    expect(createTransport).toBeTypeOf('function');
    if (typeof createTransport !== 'function') return;

    const sendFrame = vi.fn();
    const fallbackChunk = vi.fn();
    const transport = createTransport({
      tunnelId: 'tun_voice',
      stream: { sendFrame, close: vi.fn() },
      controlTransport: {
        start: async (payload: DaemonVoiceInferenceSttStreamStartRequest) => startResponse(payload),
        finish: async (payload: { streamId: string; generation: number; finalSeq: number }) => ({
          ok: true as const,
          streamId: payload.streamId,
          generation: payload.generation,
          ackSeq: payload.finalSeq,
          finalText: '',
          language: null,
          modelPackId: null,
          events: [],
        }),
        cancel: async (payload: { streamId: string; generation: number }) => ({
          ok: true as const,
          streamId: payload.streamId,
          generation: payload.generation,
        }),
      },
      fallbackTransport: { chunk: fallbackChunk },
    });
    const adapter = createDaemonSpeechStreamCarrierAdapter({
      routeKind: 'loopback_direct',
      binaryCapable: true,
    });
    const carrierFrame = adapter.encodeInputAppendFrame({
      streamId: 'stream-1',
      generation: 3,
      seq: 5,
      pcm16Bytes: new Uint8Array([1, 2, 3, 4]),
    });

    await expect(transport.chunk({
      streamId: 'stream-1',
      generation: 3,
      seq: 5,
      carrierFrame,
      compatibilityTransport: null,
    })).resolves.toEqual({
      ok: false,
      error: 'daemon_voice_inference_tunnel_substream_unavailable',
      errorCode: 'internal_error',
    });

    expect(sendFrame).not.toHaveBeenCalled();
    expect(fallbackChunk).not.toHaveBeenCalled();
  });
});

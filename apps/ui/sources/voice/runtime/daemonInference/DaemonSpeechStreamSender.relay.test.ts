import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { createPeerTcpTunnelApplicationSubstreamSession } from '@happier-dev/peer-transport';
import { decodePeerTcpTunnelBinaryFrameV2, PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
  PeerTcpTunnelRelayEnvelopeSchema, createSpeechTranscriptionApplicationAuthorityDigestV1,
  createPeerTcpTunnelRelayAuthorizationSigningInputV2,
  DaemonVoiceInferenceSttStreamChunkResponseSchema, DaemonVoiceInferenceSttStreamFinishResponseSchema,
  type PeerTcpTunnelRelayEnvelope, type PeerApplicationEncryptionAuthorityBindingV1,
} from '@happier-dev/protocol';
import { openPeerTcpTunnelRelayStream } from '@/sync/domains/machines/peer/mediation/tunnel/relayStream';
import { createVoiceInferenceSpeechStreamManager } from '../../../../../cli/src/daemon/voiceInference/streaming/voiceInferenceSpeechStreamManager';
import { dispatchDaemonVoiceInferenceSttBinaryAppend } from '../../../../../cli/src/daemon/peer/mediation/tunnel/voiceBinaryAppend';
import { createDaemonSpeechStreamSender } from './DaemonSpeechStreamSender';
import { createDaemonSpeechStreamCarrierAdapter } from './DaemonSpeechStreamCarrier';
import { createDaemonSpeechStreamTunnelTransport } from './DaemonSpeechStreamTunnelTransport';

describe('sender → encrypted relay framing → daemon STT intake', () => {
  it('drains a long capture after delayed replies without losing PCM or exceeding negotiated packets', async () => {
    const streamRoot = await mkdtemp(join(tmpdir(), 'happier-df66-intake-'));
    const received: Uint8Array[] = [];
    const binding: PeerApplicationEncryptionAuthorityBindingV1 = {
      v: 1, suite: 'aes-256-gcm', flowKind: 'voice_media', routeKind: 'server_relay',
      authorityDigest: 'sha256:' + 'a'.repeat(64), accountId: 'account', machineId: 'machine', tunnelId: 'tunnel',
      applicationKind: 'speech_transcription', applicationAttemptId: 'request',
      applicationAuthorityDigest: createSpeechTranscriptionApplicationAuthorityDigestV1('request'),
    };
    const manager = createVoiceInferenceSpeechStreamManager({ streamRoot,
      // The native worker process is the boundary. Intake, encryption, framing,
      // sequence admission, acknowledgement and finalization stay real.
      voiceInferenceWorker: {
        transcribeAudio: async () => { throw new Error('batch STT must not run'); }, cancelStt: async () => {},
        createStreamingTranscriptionSession: async () => ({ modelPackId: 'pack',
          appendPcm16: async ({ pcm16Bytes, seq }) => { received.push(new Uint8Array(pcm16Bytes)); return {
            events: [{ type: 'partial', seq, text: String(seq), isEndpoint: false, confidence: null }],
          }; },
          finish: async () => ({ text: 'complete', language: 'en', events: [] }), cancel: async () => {}, close: async () => {},
        }),
      },
    });
    let receive: ((envelope: PeerTcpTunnelRelayEnvelope) => void) | undefined;
    let holdReplies = false;
    const replies: Array<() => void> = [];
    const operations: Promise<unknown>[] = [];
    const maxFrameBytes = 64 * 1024;
    const destination = { host: '127.0.0.1', port: 3000 };
    const authorizationPayload = { v: 2 as const, grantId: 'grant', accountId: binding.accountId,
      targetMachineId: binding.machineId, flowKind: binding.flowKind, routeKind: binding.routeKind,
      tunnelId: binding.tunnelId, relaySocketId: 'tab', destination, capProfileId: 'interactive', maxFrameBytes,
      applicationKind: binding.applicationKind, applicationAttemptId: binding.applicationAttemptId,
      applicationAuthorityDigest: binding.applicationAuthorityDigest,
      iat: 1, exp: 60_001, aud: 'happier-tcp-tunnel-relay-authorization' as const,
    };
    const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(5));
    const relayAuthorization = { payload: authorizationPayload, signature: { keyId: 'fixture', alg: 'Ed25519' as const,
      valueBase64Url: Buffer.from(tweetnacl.sign.detached(new TextEncoder().encode(createPeerTcpTunnelRelayAuthorizationSigningInputV2(authorizationPayload)), key.secretKey)).toString('base64url'),
    } };
    const application = createPeerTcpTunnelApplicationSubstreamSession({ tunnelId: binding.tunnelId,
      maxBinaryHeaderBytes: maxFrameBytes, maxFrameBytes, maxConcurrentSubstreams: 1,
      onTerminal: async () => {},
      sendBinaryFrame: async frame => {
        const decoded = decodePeerTcpTunnelBinaryFrameV2({ frame, maxHeaderBytes: maxFrameBytes, maxPayloadBytes: maxFrameBytes });
        expect(decoded.ok).toBe(true);
        if (decoded.ok && decoded.header.kind === 'data' && holdReplies) await new Promise<void>(resolve => replies.push(resolve));
        receive?.(PeerTcpTunnelRelayEnvelopeSchema.parse({ v: 2, scopeUserId: binding.accountId,
          sender: { kind: 'machine', machineId: binding.machineId }, recipient: { kind: 'user', socketId: 'tab' },
          encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2, frame,
        }));
      },
    });
    const stream = await openPeerTcpTunnelRelayStream({ scopeUserId: binding.accountId, relaySocketId: 'tab',
      open: { v: 1, kind: 'open', tunnelId: binding.tunnelId, targetMachineId: binding.machineId,
        routeKind: 'server_relay', destination, relayAuthorization,
        selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2 },
      onEnvelope: handler => { receive = handler; return () => { receive = undefined; }; },
      send: (_event, envelope) => {
        const strict = PeerTcpTunnelRelayEnvelopeSchema.parse(envelope);
        if (strict.v !== 2) return;
        const decoded = decodePeerTcpTunnelBinaryFrameV2({ frame: strict.frame, maxHeaderBytes: maxFrameBytes, maxPayloadBytes: maxFrameBytes });
        if (!decoded.ok || decoded.header.kind !== 'data') return;
        operations.push(application.acceptBinaryFrame(strict.frame, async ({ payload }) => {
          let response: Uint8Array | null = null;
          const handled = await dispatchDaemonVoiceInferenceSttBinaryAppend({
            header: decoded.header, payload, peerApplicationEncryption: binding, voiceMediaApplicationAuthority: binding,
            consumer: input => manager.appendPeerApplicationFrame({ binding, streamId: input.streamId, generation: input.generation,
              substreamId: input.substreamId!, carrierSequence: input.carrierSequence!, payloadBytes: input.pcm16Bytes }),
            onResponse: value => { if (!(value instanceof Uint8Array)) throw new Error('encrypted response required'); response = value; },
          });
          expect(handled).toBe(true);
          return response;
        }));
      },
    });
    const transport = createDaemonSpeechStreamTunnelTransport({ tunnelId: binding.tunnelId, stream, maxFrameBytes, responseTimeoutMs: 500,
      peerApplicationEncryption: binding, controlTransport: { start: manager.start, finish: manager.finish, cancel: manager.cancel },
    });
    const sender = createDaemonSpeechStreamSender({ requestId: 'request', packId: 'pack', transport,
      carrierAdapter: createDaemonSpeechStreamCarrierAdapter({ routeKind: 'server_relay', binaryCapable: true }),
    });
    try {
      await sender.start();
      holdReplies = true;
      const expected: Uint8Array[] = [];
      const outcomes: Promise<unknown>[] = [];
      for (let frame = 0; frame < 425; frame++) {
        const pcm = new Uint8Array(640).fill(frame % 256);
        expected.push(pcm);
        outcomes.push(sender.pushChunk(pcm).then(events => events, (error: unknown) => ({ error })));
      }
      let finished = false;
      const finish = sender.finish().then(result => { finished = true; return { result }; }, (error: unknown) => { finished = true; return { error }; });
      while (!finished) {
        await expect.poll(() => finished || replies.length > 0).toBe(true);
        for (const release of replies.splice(0)) release();
      }
      const outcome = await finish;
      expect(outcome).not.toHaveProperty('error');
      if (!('result' in outcome)) throw outcome.error;
      const result = DaemonVoiceInferenceSttStreamFinishResponseSchema.parse(outcome.result);
      expect(result).toMatchObject({ ok: true, finalText: 'complete' });
      const events = (await Promise.all(outcomes)).flat();
      expect(events.some(event => event && typeof event === 'object' && 'error' in event)).toBe(false);
      expect(Buffer.concat(received)).toEqual(Buffer.concat(expected));
      expect(received.some(pcm => pcm.byteLength > 640)).toBe(true);
      if (result.ok) DaemonVoiceInferenceSttStreamChunkResponseSchema.parse({ ok: true, streamId: result.streamId,
        generation: result.generation, ackSeq: result.ackSeq, events });
      await Promise.all(operations);
    } finally {
      for (const release of replies.splice(0)) release();
      await sender.cancel(); await stream.close(); await application.close(); await manager.dispose();
      await rm(streamRoot, { recursive: true, force: true });
    }
  });
});

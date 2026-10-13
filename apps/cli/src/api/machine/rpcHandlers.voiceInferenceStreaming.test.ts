import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createSpeechTranscriptionApplicationAuthorityDigestV1,
  DaemonVoiceInferenceSttStreamChunkRequestSchema,
  type DaemonVoiceInferenceSttStreamEvent,
  ModelPackManifestSchema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { configuration, reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { resolveVoiceInferencePaths } from '@/daemon/voiceInference/voiceInferencePaths';
import { startVoiceInferenceWorker, type VoiceInferenceWorkerHandle } from '@/daemon/voiceInference/voiceInferenceWorker';
import type { VoiceInferenceRuntime, VoiceInferenceRuntimeTranscribeInput, VoiceInferenceStreamingTranscriptionSession as RuntimeStreamSession } from '@/daemon/voiceInference/voiceInferenceRuntimeTypes';

import { registerMachineVoiceInferenceStreamingRpcHandlers } from './rpcHandlers.voiceInferenceStreaming';

import { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { RpcHandler as Handler } from '../rpc/types';
const originalSttMaxUploadBytes = process.env.HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES;

function createRpcHandlerManager(): RpcHandlerManager {
  return new RpcHandlerManager({
    scopePrefix: 'voice-inference-test',
    encryptionKey: new Uint8Array(32),
    encryptionVariant: 'legacy',
    encryptionMode: 'plain',
    logger: () => {},
  });
}

function getHandler(manager: RpcHandlerManager, method: string): Handler | undefined {
  if (!manager.hasHandler(method)) return undefined;
  return async (params, context) => await manager.invokeLocal(method, params, {
    signal: context?.signal,
  });
}

const workers: VoiceInferenceWorkerHandle[] = [];
const registrations: Array<ReturnType<typeof registerMachineVoiceInferenceStreamingRpcHandlers>> = [];
const homes: string[] = [];
const packId = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';
let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'voice-rpc-stream-home-'));
  homes.push(home);
  process.env.HAPPIER_HOME_DIR = home;
  reloadConfiguration();
  const packDir = join(resolveVoiceInferencePaths().packsRootDir, packId);
  const bytes = Buffer.from('native-stt-model-fixture');
  mkdirSync(packDir, { recursive: true });
  const manifest = ModelPackManifestSchema.parse({
    packId, kind: 'stt_sherpa', model: 'zipformer', version: '2023-02-17',
    files: [{
      path: 'model.onnx', url: 'https://example.test/model.onnx',
      sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength,
    }],
  });
  writeFileSync(join(packDir, 'pack.json'), JSON.stringify(manifest));
  writeFileSync(join(packDir, 'model.onnx'), bytes);
});

async function createWorker(runtime: Partial<VoiceInferenceRuntime>) {
  // Recognition/native stream sessions are the genuine engine boundary.
  const worker = await startVoiceInferenceWorker({
    runtimeLoader: async () => ({
      synthesizeTts: async () => { throw new Error('unused native synthesis'); },
      transcribeAudio: async () => { throw new Error('unused native recognition'); },
      ...runtime,
    }),
  });
  workers.push(worker);
  return worker;
}

afterEach(async () => {
  await Promise.all(registrations.splice(0).map((registration) => registration.dispose()));
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  envScope.restore();
  envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
  reloadConfiguration();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  if (originalSttMaxUploadBytes === undefined) {
    delete process.env.HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES;
  } else {
    process.env.HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES = originalSttMaxUploadBytes;
  }
});

describe('registerMachineVoiceInferenceStreamingRpcHandlers', () => {
  it('cancels the exact authority-bound stream once when its peer transport is lost', async () => {
    const runtimeSession: RuntimeStreamSession = {
      appendPcm16: vi.fn(async () => ({ events: [] })),
      finish: vi.fn(async () => ({ text: '', language: null, events: [] })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const worker = await createWorker({
      transcribeAudio: async () => { throw new Error('unused native recognition'); },
      createStreamingTranscriptionSession: vi.fn(async () => runtimeSession),
    });
    const cancelStt = vi.spyOn(worker, 'cancelStt');
    const mgr = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    });
    registrations.push(registration);
    const sttStreamStart = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamStatus = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_STATUS);
    const requestId = 'transport-loss-request';
    const authority = {
      v: 1 as const,
      applicationKind: 'speech_transcription' as const,
      applicationAttemptId: requestId,
      applicationAuthorityDigest: createSpeechTranscriptionApplicationAuthorityDigestV1(requestId),
    };
    const started = await sttStreamStart?.({
      requestId,
      packId,
      language: null,
      streamingMode: 'runtime',
    });
    expect(started).toMatchObject({ ok: true, generation: 0 });

    await expect(registration.cancelSttStreamForTransportLoss({
      streamId: started.streamId,
      generation: started.generation,
      voiceMediaApplicationAuthority: {
        ...authority,
        applicationAttemptId: 'another-request',
        applicationAuthorityDigest:
          createSpeechTranscriptionApplicationAuthorityDigestV1('another-request'),
      },
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_stream_state' });
    await expect(sttStreamStatus?.({
      streamId: started.streamId,
      generation: started.generation,
    })).resolves.toMatchObject({ ok: true, state: 'open' });

    await expect(registration.cancelSttStreamForTransportLoss({
      streamId: started.streamId,
      generation: started.generation,
      voiceMediaApplicationAuthority: authority,
    })).resolves.toMatchObject({ ok: true });
    await expect(registration.cancelSttStreamForTransportLoss({
      streamId: started.streamId,
      generation: started.generation,
      voiceMediaApplicationAuthority: authority,
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });
    await expect(sttStreamStatus?.({
      streamId: started.streamId,
      generation: started.generation,
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });
    expect(runtimeSession.cancel).toHaveBeenCalledOnce();
    expect(runtimeSession.close).toHaveBeenCalledOnce();
    expect(cancelStt).toHaveBeenCalledOnce();
  });

  it('cancels the authority-bound stream when transport is lost before its first carrier frame', async () => {
    const runtimeSession: RuntimeStreamSession = {
      appendPcm16: vi.fn(async () => ({ events: [] })),
      finish: vi.fn(async () => ({ text: '', language: null, events: [] })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const worker = await createWorker({
      transcribeAudio: async () => { throw new Error('unused native recognition'); },
      createStreamingTranscriptionSession: vi.fn(async () => runtimeSession),
    });
    const cancelStt = vi.spyOn(worker, 'cancelStt');
    const mgr = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    });
    registrations.push(registration);
    const sttStreamStart = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamStatus = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_STATUS);
    const requestId = 'transport-loss-before-first-frame';
    const authority = {
      v: 1 as const,
      applicationKind: 'speech_transcription' as const,
      applicationAttemptId: requestId,
      applicationAuthorityDigest: createSpeechTranscriptionApplicationAuthorityDigestV1(requestId),
    };
    const started = await sttStreamStart?.({
      requestId,
      packId,
      language: null,
      streamingMode: 'runtime',
    });
    expect(started).toMatchObject({ ok: true, generation: 0 });

    const lossResult = await registration.cancelSttStreamForTransportLoss({
      voiceMediaApplicationAuthority: authority,
    });
    if (!lossResult.ok) {
      await registration.cancelSttStreamForTransportLoss({
        streamId: started.streamId,
        generation: started.generation,
        voiceMediaApplicationAuthority: authority,
      });
    }
    expect(lossResult).toMatchObject({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
    });
    await expect(sttStreamStatus?.({
      streamId: started.streamId,
      generation: started.generation,
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });
    expect(runtimeSession.cancel).toHaveBeenCalledOnce();
    expect(runtimeSession.close).toHaveBeenCalledOnce();
    expect(cancelStt).toHaveBeenCalledOnce();
  });

  it('binds transport-loss cleanup to signed application authority instead of forged carrier identity', async () => {
    const runtimeSession: RuntimeStreamSession = {
      appendPcm16: vi.fn(async () => ({ events: [] })),
      finish: vi.fn(async () => ({ text: '', language: null, events: [] })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const worker = await createWorker({
      transcribeAudio: async () => { throw new Error('unused native recognition'); },
      createStreamingTranscriptionSession: vi.fn(async () => runtimeSession),
    });
    const cancelStt = vi.spyOn(worker, 'cancelStt');
    const mgr = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    });
    registrations.push(registration);
    const sttStreamStart = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamStatus = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_STATUS);
    const requestId = 'transport-loss-forged-carrier';
    const authority = {
      v: 1 as const,
      applicationKind: 'speech_transcription' as const,
      applicationAttemptId: requestId,
      applicationAuthorityDigest: createSpeechTranscriptionApplicationAuthorityDigestV1(requestId),
    };
    const started = await sttStreamStart?.({
      requestId,
      packId,
      language: null,
      streamingMode: 'runtime',
    });
    expect(started).toMatchObject({ ok: true, generation: 0 });

    await expect(registration.cancelSttStreamForTransportLoss({
      streamId: 'forged-carrier-stream',
      generation: started.generation + 1,
      voiceMediaApplicationAuthority: authority,
    })).resolves.toMatchObject({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
    });
    await expect(sttStreamStatus?.({
      streamId: started.streamId,
      generation: started.generation,
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });
    expect(runtimeSession.cancel).toHaveBeenCalledOnce();
    expect(runtimeSession.close).toHaveBeenCalledOnce();
    expect(cancelStt).toHaveBeenCalledOnce();
  });

  it('streams daemon STT PCM chunks into a canonical wav file and transcribes through the worker on finish', async () => {
    let observedInput: VoiceInferenceRuntimeTranscribeInput | null = null;
    const transcribeAudio = vi.fn(async (input: NonNullable<typeof observedInput>) => {
      observedInput = input;
      const wav = readFileSync(input.filePath);
      expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
      expect(wav.readUInt16LE(22)).toBe(1);
      expect(wav.readUInt32LE(24)).toBe(16_000);
      expect(wav.readUInt16LE(34)).toBe(16);
      expect(wav.subarray(36, 40).toString('ascii')).toBe('data');
      expect(wav.readUInt32LE(40)).toBe(4);
      expect(wav.subarray(44).equals(Buffer.from([0, 0, 1, 0]))).toBe(true);
      return {
        requestId: input.requestId,
        text: 'streamed daemon transcript',
        language: input.language,
        modelPackId: input.packId,
      };
    });
    const worker = await createWorker({
      transcribeAudio,
    });
    const mgr = createRpcHandlerManager();
    registrations.push(registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    }));

    const sttStreamStart = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamChunk = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK);
    const sttStreamFinish = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_FINISH);
    const sttStreamStatus = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_STATUS);

    const started = await sttStreamStart?.({
      requestId: 'stream-request-1',
      packId,
      language: 'en',
      streamingMode: 'upload_bridge',
    });
    expect(started).toEqual(expect.objectContaining({
      ok: true,
      requestId: 'stream-request-1',
      streamId: expect.any(String),
      generation: 0,
      ackSeq: -1,
    }));
    await expect(sttStreamChunk?.({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Base64: Buffer.from([0, 0, 1, 0]).toString('base64'),
    })).resolves.toEqual({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
      ackSeq: 0,
      events: [],
    });
    await expect(sttStreamStatus?.({
      streamId: started.streamId,
      generation: started.generation,
    })).resolves.toEqual({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
      ackSeq: 0,
      state: 'open',
    });
    await expect(sttStreamFinish?.({
      streamId: started.streamId,
      generation: started.generation,
      finalSeq: 0,
    })).resolves.toEqual({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
      ackSeq: 0,
      finalText: 'streamed daemon transcript',
      language: 'en',
      modelPackId: packId,
      events: [{ type: 'final', seq: 0, text: 'streamed daemon transcript', language: 'en', modelPackId: packId }],
    });
    expect(observedInput).toMatchObject({
      requestId: 'stream-request-1',
      inputMimeType: 'audio/wav',
      packId,
      language: 'en',
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'ui_pretranscoded_pcm16_fallback',
        systemFfmpegAllowed: false,
      },
    });
  });

  it('accepts raw PCM16 bytes through the binary append consumer without parsing the compatibility chunk schema', async () => {
    const transcribeAudio = vi.fn(async (input: { filePath: string; requestId: string; language: string | null; packId: string | null }) => {
      const wav = readFileSync(input.filePath);
      expect(wav.readUInt32LE(40)).toBe(4);
      expect([...wav.subarray(44)]).toEqual([0, 0, 1, 0]);
      return {
        requestId: input.requestId,
        text: 'binary daemon transcript',
        language: input.language,
        modelPackId: input.packId,
      };
    });
    const worker = await createWorker({
      transcribeAudio,
    });
    const mgr = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    });
    registrations.push(registration);
    const sttStreamStart = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamFinish = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_FINISH);
    const safeParseSpy = vi.spyOn(DaemonVoiceInferenceSttStreamChunkRequestSchema, 'safeParse');

    const started = await sttStreamStart?.({
      requestId: 'stream-request-binary',
      packId,
      language: 'en',
      streamingMode: 'upload_bridge',
    });
    expect(started).toMatchObject({ ok: true, streamId: expect.any(String), generation: 0, ackSeq: -1 });
    safeParseSpy.mockClear();

    await expect(registration.appendSttStreamBinaryFrame({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0, 1, 0]),
    })).resolves.toEqual({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
      ackSeq: 0,
      events: [],
    });
    expect(safeParseSpy).not.toHaveBeenCalled();

    await expect(registration.appendSttStreamBinaryFrame({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([9, 9, 9, 9]),
    })).resolves.toMatchObject({
      ok: true,
      ackSeq: 0,
    });
    await expect(sttStreamFinish?.({
      streamId: started.streamId,
      generation: started.generation,
      finalSeq: 0,
    })).resolves.toMatchObject({
      ok: true,
      ackSeq: 0,
      finalText: 'binary daemon transcript',
    });
  });

  it('emits runtime streaming partial and endpoint events before finish and final events on finish', async () => {
    const runtimeEvents: DaemonVoiceInferenceSttStreamEvent[][] = [];
    const runtimeSession: RuntimeStreamSession = {
      appendPcm16: vi.fn(async (input) => {
        expect(input.seq).toBe(0);
        expect([...input.pcm16Bytes]).toEqual([0, 0, 1, 0]);
        const events: DaemonVoiceInferenceSttStreamEvent[] = [
          { type: 'partial', seq: input.seq, text: 'hel', isEndpoint: false, confidence: null },
          { type: 'endpoint', seq: input.seq, transcript: 'hello', reason: 'vad' },
        ];
        runtimeEvents.push(events);
        return { events };
      }),
      finish: vi.fn(async (input) => {
        expect(input.finalSeq).toBe(0);
        const events: DaemonVoiceInferenceSttStreamEvent[] = [{ type: 'final', seq: 0, text: 'hello world', language: 'en', modelPackId: packId }];
        runtimeEvents.push(events);
        return { text: 'hello world', language: 'en', events };
      }),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const transcribeAudio = vi.fn(async () => {
      throw new Error('runtime_mode_must_not_batch_transcribe');
    });
    const createStreamingTranscriptionSession = vi.fn(async () => runtimeSession);
    const worker = await createWorker({
      transcribeAudio,
      createStreamingTranscriptionSession,
    });
    const mgr = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    });
    registrations.push(registration);
    const sttStreamStart = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamFinish = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_FINISH);

    const started = await sttStreamStart?.({
      requestId: 'stream-request-runtime',
      packId,
      language: 'en',
      streamingMode: 'runtime',
    });
    expect(started).toMatchObject({ ok: true, streamId: expect.any(String), generation: 0, ackSeq: -1 });

    await expect(registration.appendSttStreamBinaryFrame({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0, 1, 0]),
    })).resolves.toEqual({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
      ackSeq: 0,
      events: [
        { type: 'partial', seq: 0, text: 'hel', isEndpoint: false, confidence: null },
        { type: 'endpoint', seq: 0, transcript: 'hello', reason: 'vad' },
      ],
    });

    await expect(registration.appendSttStreamBinaryFrame({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([9, 9, 9, 9]),
    })).resolves.toEqual({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
      ackSeq: 0,
      events: [],
    });

    await expect(sttStreamFinish?.({
      streamId: started.streamId,
      generation: started.generation,
      finalSeq: 0,
    })).resolves.toEqual({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
      ackSeq: 0,
      finalText: 'hello world',
      language: 'en',
      modelPackId: packId,
      events: [{ type: 'final', seq: 0, text: 'hello world', language: 'en', modelPackId: packId }],
    });

    expect(createStreamingTranscriptionSession).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'stream-request-runtime',
      packId,
      language: 'en',
    }));
    expect(runtimeSession.appendPcm16).toHaveBeenCalledTimes(1);
    expect(runtimeSession.finish).toHaveBeenCalledTimes(1);
    expect(runtimeSession.close).toHaveBeenCalledTimes(1);
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(runtimeEvents.map((events) => (events[0] as { type: string }).type)).toEqual(['partial', 'final']);
  });

  it('fails closed when runtime streaming is requested but the worker cannot create a stream', async () => {
    const worker = await createWorker({
      transcribeAudio: vi.fn(async () => {
        throw new Error('unused');
      }),
    });
    const mgr = createRpcHandlerManager();
    registrations.push(registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    }));
    const sttStreamStart = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);

    await expect(sttStreamStart?.({
      requestId: 'stream-runtime-unavailable',
      packId,
      language: 'en',
      streamingMode: 'runtime',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'runtime_unavailable',
    });
  });

  it('fails closed when streaming mode is omitted at the RPC boundary', async () => {
    const worker = await createWorker({
      transcribeAudio: vi.fn(async () => {
        throw new Error('omitted_mode_must_not_upload_bridge');
      }),
    });
    const mgr = createRpcHandlerManager();
    registrations.push(registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    }));
    const sttStreamStart = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);

    await expect(sttStreamStart?.({
      requestId: 'stream-mode-omitted',
      packId,
      language: 'en',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'invalid_stream_state',
    });
  });

  it('cancels runtime streaming sessions and rejects mismatched generation appends', async () => {
    const runtimeSession: RuntimeStreamSession = {
      appendPcm16: vi.fn(async () => ({ events: [] })),
      finish: vi.fn(async () => ({ text: '', language: null, events: [] })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const worker = await createWorker({
      transcribeAudio: vi.fn(async () => {
        throw new Error('unused');
      }),
      createStreamingTranscriptionSession: vi.fn(async () => runtimeSession),
    });
    const cancelStt = vi.spyOn(worker, 'cancelStt');
    const mgr = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    });
    registrations.push(registration);
    const sttStreamStart = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamCancel = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CANCEL);

    const started = await sttStreamStart?.({
      requestId: 'stream-runtime-cancel',
      packId,
      language: 'en',
      streamingMode: 'runtime',
    });
    expect(started).toMatchObject({ ok: true, streamId: expect.any(String), generation: 0 });

    await expect(registration.appendSttStreamBinaryFrame({
      streamId: started.streamId,
      generation: started.generation + 1,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0]),
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });

    await expect(sttStreamCancel?.({
      streamId: started.streamId,
      generation: started.generation,
    })).resolves.toEqual({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
    });
    expect(runtimeSession.cancel).toHaveBeenCalledOnce();
    expect(runtimeSession.close).toHaveBeenCalledOnce();
    expect(cancelStt).toHaveBeenCalledWith('stream-runtime-cancel');
  });

  it('rejects binary append stream identity, ordering, PCM, cap, and lifecycle violations', async () => {
    // The canonical worker's upload budget includes the 44-byte WAV header.
    process.env.HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES = '48';
    const finishRelease = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
      });
      return { promise, resolve };
    })();
    const worker = await createWorker({
      transcribeAudio: vi.fn(async () => {
        await finishRelease.promise;
        return { requestId: 'stream-request-binary-negative', text: '', language: null, modelPackId: null };
      }),
    });
    const mgr = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    });
    registrations.push(registration);
    const sttStreamStart = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamFinish = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_FINISH);

    const started = await sttStreamStart?.({
      requestId: 'stream-request-binary-negative',
      packId,
      language: null,
      streamingMode: 'upload_bridge',
    });
    expect(started).toMatchObject({ ok: true, streamId: expect.any(String), generation: 0 });

    await expect(registration.appendSttStreamBinaryFrame({
      streamId: 'missing-stream',
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0]),
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });
    await expect(registration.appendSttStreamBinaryFrame({
      streamId: started.streamId,
      generation: started.generation + 1,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0]),
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });
    await expect(registration.appendSttStreamBinaryFrame({
      streamId: started.streamId,
      generation: started.generation,
      seq: 1,
      pcm16Bytes: new Uint8Array([0, 0]),
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_stream_state' });
    await expect(registration.appendSttStreamBinaryFrame({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([]),
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_stream_state' });
    await expect(registration.appendSttStreamBinaryFrame({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([0]),
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_stream_state' });
    await expect(registration.appendSttStreamBinaryFrame({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array(50),
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_stream_state' });

    await expect(registration.appendSttStreamBinaryFrame({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0]),
    })).resolves.toMatchObject({ ok: true, ackSeq: 0 });
    const finishing = sttStreamFinish?.({
      streamId: started.streamId,
      generation: started.generation,
      finalSeq: 0,
    });
    await expect(registration.appendSttStreamBinaryFrame({
      streamId: started.streamId,
      generation: started.generation,
      seq: 1,
      pcm16Bytes: new Uint8Array([1, 0]),
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_stream_state' });
    finishRelease.resolve();
    await expect(finishing).resolves.toMatchObject({ ok: true });
    await expect(registration.appendSttStreamBinaryFrame({
      streamId: started.streamId,
      generation: started.generation,
      seq: 1,
      pcm16Bytes: new Uint8Array([1, 0]),
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });
  });

  it('expires abandoned daemon STT streams and cancels their worker request', async () => {
    vi.useFakeTimers();
    const worker = await createWorker({
      transcribeAudio: vi.fn(async () => {
        throw new Error('unused');
      }),
    });
    const cancelStt = vi.spyOn(worker, 'cancelStt');
    const mgr = createRpcHandlerManager();
    registrations.push(registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    }));

    const sttStreamStart = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamStatus = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_STATUS);

    const started = await sttStreamStart?.({
      requestId: 'stream-request-expire',
      packId,
      language: 'en',
      streamingMode: 'upload_bridge',
    });
    expect(started).toMatchObject({ ok: true, streamId: expect.any(String), generation: 0 });

    await expect(sttStreamStatus?.({
      streamId: started.streamId,
      generation: started.generation,
    })).resolves.toMatchObject({ ok: true, state: 'open' });

    await vi.advanceTimersByTimeAsync(configuration.filesTransferSessionTtlMs + 1);

    await expect(sttStreamStatus?.({
      streamId: started.streamId,
      generation: started.generation,
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'stream_not_found',
    });
    expect(cancelStt).toHaveBeenCalledWith('stream-request-expire');
    expect(vi.getTimerCount()).toBe(0);
  });
});

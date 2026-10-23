import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseModelPackManifest } from '@happier-dev/protocol/voice/modelPacks/manifest';
import { createVoiceSpeechOutputBoundary } from '@/dev/testkit/harness/voiceSpeechOutputBoundary';
import { createVoicePlaybackController } from '@/voice/runtime/playback/VoicePlaybackController';
import { createDeferred } from '@/dev/testkit';

const speechBoundary = createVoiceSpeechOutputBoundary({ getAccount: () => { throw new Error('Unexpected daemon RPC in native Kokoro contract'); } });
afterAll(() => speechBoundary.disposeAudioSession());
const { native, encodedAudio: playback } = speechBoundary;
let filesystem: ReturnType<typeof speechBoundary.reset>['filesystem'];
const packId = 'kokoro-output-contract';

import { speakKokoroText } from '@/voice/output/KokoroTtsController';

describe('speakKokoroText', () => {
  beforeEach(() => {
    filesystem = speechBoundary.reset().filesystem;
    playback.start.mockImplementation(async () => {});
    const manifest = parseModelPackManifest({ packId, kind: 'tts_sherpa', model: 'kokoro', version: '1',
      frontend: { lang: 'en' }, voices: [{ id: 'af_heart', title: 'Heart', sid: 0 }], defaultVoiceId: 'af_heart',
      files: [{ path: 'model.onnx', url: 'https://example.test/model.onnx', sha256: 'a'.repeat(64), sizeBytes: 1 }] });
    filesystem.files.set(`${filesystem.root}/${packId}/pack.json`, new TextEncoder().encode(JSON.stringify({ manifest })));
  });
  afterEach(() => { speechBoundary.disposeNativeSdkBridge(); });

  it('does not start native audio when interrupted before its playback target registers', async () => {
    const controller = createVoicePlaybackController();
    playback.start.mockImplementationOnce(async () => { playback.emit('started'); playback.emit('finished'); });
    const write = vi.spyOn(filesystem.fs.File.prototype, 'write').mockImplementationOnce(() => {
      controller.interrupt();
    });
    try {
      await speakKokoroText({ text: 'Hello.', assetSetId: packId, voiceId: 'af_heart', speed: 1,
        timeoutMs: 15_000, registerPlaybackStopper: controller.registerStopper.captureAttempt!() });

      expect(playback.start).not.toHaveBeenCalled();
      expect(speechBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
    } finally {
      write.mockRestore();
    }
  });

  it('registers a stopper that aborts in-flight synthesis', async () => {
    const initializing = createDeferred<void>();
    native.initialize.mockImplementationOnce(() => {
      initializing.resolve();
      return new Promise<void>(() => {});
    });
    let stopper: (() => void) | undefined;
    const onPlaybackStarted = vi.fn();
    const speaking = speakKokoroText({ text: 'Hello.', assetSetId: packId, voiceId: 'af_heart', speed: 1,
      timeoutMs: 15_000, registerPlaybackStopper: next => { stopper = next; return () => {}; }, onPlaybackStarted });
    await initializing.promise;
    expect(native.initialize).toHaveBeenCalledOnce();
    stopper!();
    await expect(speaking).rejects.toThrow('aborted');
    expect(native.cancelInitialization).toHaveBeenCalledOnce();
    expect(playback.start).not.toHaveBeenCalled();
    expect(onPlaybackStarted).not.toHaveBeenCalled();
  });

  it('reports playback start once on the first actual segment and completes after final playback', async () => {
    const onPlaybackStarted = vi.fn();
    const firstSegment = createDeferred<void>();
    const secondSegment = createDeferred<void>();
    playback.start.mockImplementationOnce(async () => { firstSegment.resolve(); });
    playback.start.mockImplementationOnce(async () => { secondSegment.resolve(); });
    let completed = false;
    const speaking = speakKokoroText({ text: 'Hello. Goodbye.', assetSetId: packId, voiceId: 'af_heart', speed: 1,
      timeoutMs: 15_000, registerPlaybackStopper: () => () => {}, onPlaybackStarted });
    void speaking.then(() => { completed = true; });
    await firstSegment.promise;
    expect(playback.start).toHaveBeenCalledTimes(1);
    expect(onPlaybackStarted).not.toHaveBeenCalled();
    playback.emit('started');
    playback.emit('finished');
    await secondSegment.promise;
    expect(playback.start).toHaveBeenCalledTimes(2);
    playback.emit('started');
    expect(onPlaybackStarted).toHaveBeenCalledOnce();
    expect(completed).toBe(false);
    expect(speechBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(1);
    playback.emit('finished');
    await speaking;
    expect(native.synthesizeToWavFile.mock.calls.map(([value]) => value.text)).toEqual(['Hello.', 'Goodbye.']);
    expect(speechBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
    expect(completed).toBe(true);
  });

  it('does not report playback start when synthesis fails before producing audio', async () => {
    native.synthesizeToWavFile.mockRejectedValueOnce(new Error('kokoro_synthesis_failed'));
    const onPlaybackStarted = vi.fn();
    await expect(speakKokoroText({ text: 'Hello.', assetSetId: packId, voiceId: 'af_heart', speed: 1,
      timeoutMs: 15_000, registerPlaybackStopper: () => () => {}, onPlaybackStarted })).rejects.toThrow('kokoro_synthesis_failed');
    expect(playback.start).not.toHaveBeenCalled();
    expect(onPlaybackStarted).not.toHaveBeenCalled();
  });
});

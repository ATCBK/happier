import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeVoicePcmCaptureHarness } from '@/dev/testkit/harness/nativeVoicePcmCapture';
import { createVoiceEncodedAudioNativeBoundary } from '@/dev/testkit/harness/voiceEncodedAudioNativeBoundary';
import { getSharedVoiceAudioSessionCoordinator } from '@happier-dev/audio-stream-native';
import { createDeferred, type Deferred } from '@/dev/testkit';

const fileDelete = vi.fn<() => Promise<void>>(async () => {});
const audioSession = createNativeVoicePcmCaptureHarness();
const native = createVoiceEncodedAudioNativeBoundary();
const nativeSdk = native.nativeModule(audioSession.nativeModule);
let nativeStarting: Deferred<void>;
vi.mock('expo-modules-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('expo-modules-core')>();
  return { ...actual, requireOptionalNativeModule: (name: string) =>
    name === 'HappierAudioStreamNative' ? nativeSdk : actual.requireOptionalNativeModule(name) };
});
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});
vi.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///tmp/' },
  File: class {
    uri: string;
    constructor(base: string, name: string) { this.uri = `${base}${name}`; }
    async write(_content: Uint8Array) {}
    delete = fileDelete;
  },
}));
vi.mock('expo-audio', () => ({
  createAudioPlayer: () => { throw new Error('expo_audio_must_not_run_on_ios'); },
}));

import { playAudioBytesWithStopper } from '@/voice/output/playAudioBytesWithStopper';
import { createVoicePlaybackController } from '@/voice/runtime/playback/VoicePlaybackController';

describe('playAudioBytesWithStopper (native iOS)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativeStarting = createDeferred<void>();
    native.start.mockImplementation(async () => { nativeStarting.resolve(); });
    fileDelete.mockResolvedValue(undefined);
  });
  afterAll(async () => { await getSharedVoiceAudioSessionCoordinator()?.dispose(); await audioSession.coordinator.dispose(); });

  it('does not start native audio when a stale attempt is rejected during registration', async () => {
    const controller = createVoicePlaybackController();
    const staleAttempt = controller.registerStopper.captureAttempt?.() ?? controller.registerStopper;
    controller.interrupt();

    await playAudioBytesWithStopper({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      format: 'mp3',
      registerPlaybackStopper: staleAttempt,
    });

    expect(native.start).not.toHaveBeenCalled();
  });

  it('plays encoded bytes through the coordinator-owned native module and never Expo Audio', async () => {
    const onPlaybackStarted = vi.fn();
    const promise = playAudioBytesWithStopper({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      format: 'mp3',
      registerPlaybackStopper: () => () => {},
      onPlaybackStarted,
    });
    await nativeStarting.promise;
    expect(native.start).toHaveBeenCalledOnce();
    expect(native.start).toHaveBeenCalledWith(expect.stringMatching(/^file:\/\/\/tmp\/happier-voice-\d+\.mp3$/));
    expect(getSharedVoiceAudioSessionCoordinator()!.getSnapshot()).toMatchObject({ leaseCount: 1,
      configuration: { mode: 'playback', input: false, output: true } });

    native.emit({ status: 'started' });
    expect(onPlaybackStarted).toHaveBeenCalledOnce();
    native.emit({ status: 'finished' });
    await promise;

    expect(getSharedVoiceAudioSessionCoordinator()!.getSnapshot().leaseCount).toBe(0);
    expect(fileDelete).toHaveBeenCalledOnce();
  });

  it('keeps native playback paused across an interruption candidate and resumes a false alarm', async () => {
    const controller = createVoicePlaybackController();
    const promise = playAudioBytesWithStopper({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      format: 'wav',
      registerPlaybackStopper: controller.registerStopper,
    });
    await nativeStarting.promise;
    expect(native.start).toHaveBeenCalledOnce();

    expect(controller.beginInterruptionCandidate()).toBe('retained');
    expect(native.setPaused).toHaveBeenCalledWith(true);
    controller.resolveInterruptionCandidate('false_alarm');
    expect(native.setPaused).toHaveBeenCalledWith(false);
    native.emit({ status: 'finished' });
    await promise;
  });

  it('fails and cleans up on a native decode error', async () => {
    const promise = playAudioBytesWithStopper({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      format: 'mp3',
      registerPlaybackStopper: () => () => {},
    });
    await nativeStarting.promise;
    expect(native.start).toHaveBeenCalledOnce();
    native.emit({ status: 'failed', reason: 'encoded_audio_decode_failed' });

    await expect(promise).rejects.toThrow('encoded_audio_decode_failed');
    expect(getSharedVoiceAudioSessionCoordinator()!.getSnapshot().leaseCount).toBe(0);
    expect(fileDelete).toHaveBeenCalledOnce();
  });

  it('cleans up when native playback cannot start', async () => {
    native.start.mockRejectedValueOnce(new Error('native_playback_start_failed'));
    await expect(playAudioBytesWithStopper({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      format: 'mp3',
      registerPlaybackStopper: () => () => {},
    })).rejects.toThrow('native_playback_start_failed');

    expect(native.stop).not.toHaveBeenCalled();
    expect(fileDelete).toHaveBeenCalledOnce();
    expect(getSharedVoiceAudioSessionCoordinator()!.getSnapshot().leaseCount).toBe(0);
  });

  it('does not let temp-file deletion hold the coordinator lease', async () => {
    let finishDeletion!: () => void;
    fileDelete.mockImplementationOnce(() => new Promise<void>(resolve => { finishDeletion = resolve; }));
    const promise = playAudioBytesWithStopper({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      format: 'mp3',
      registerPlaybackStopper: () => () => {},
    });
    await nativeStarting.promise;
    expect(native.start).toHaveBeenCalledOnce();
    native.emit({ status: 'finished' });

    await promise;
    expect(getSharedVoiceAudioSessionCoordinator()!.getSnapshot().leaseCount).toBe(0);
    expect(fileDelete).toHaveBeenCalledOnce();
    finishDeletion();
  });

  it('stops promptly and ignores a late native completion', async () => {
    const stopperRef: { current: (() => void) | null } = { current: null };
    const promise = playAudioBytesWithStopper({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      format: 'mp3',
      registerPlaybackStopper: (stop) => { stopperRef.current = stop; return () => {}; },
    });
    await nativeStarting.promise;
    expect(native.start).toHaveBeenCalledOnce();
    stopperRef.current?.();
    await promise;
    native.emit({ status: 'finished' });

    expect(native.stop).toHaveBeenCalledOnce();
    expect(getSharedVoiceAudioSessionCoordinator()!.getSnapshot().leaseCount).toBe(0);
  });

  it('settles replacement as cancellation and releases its file and audio lease once', async () => {
    const promise = playAudioBytesWithStopper({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      format: 'mp3',
      registerPlaybackStopper: () => () => {},
    });
    await nativeStarting.promise;
    expect(native.start).toHaveBeenCalledOnce();

    native.emit({ status: 'replaced', reason: 'encoded_audio_replaced' });
    await promise;
    native.emit({ status: 'finished' });

    expect(native.stop).not.toHaveBeenCalled();
    expect(fileDelete).toHaveBeenCalledOnce();
    expect(getSharedVoiceAudioSessionCoordinator()!.getSnapshot().leaseCount).toBe(0);
  });
});

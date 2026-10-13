import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVoiceSpeechOutputBoundary } from '@/dev/testkit/harness/voiceSpeechOutputBoundary';
import { createDeferred } from '@/dev/testkit';
import { parseModelPackManifest } from '@happier-dev/protocol/voice/modelPacks/manifest';

const audio = vi.hoisted(() => ({ play: vi.fn(), remove: vi.fn(), detach: vi.fn() }));
// Expo audio is the OS playback boundary. Audio-mode and preview lifecycle owners remain real.
vi.mock('expo-audio', () => ({
  AudioModule: { setAudioModeAsync: async () => {} },
  createAudioPlayer: () => ({ play: audio.play, remove: audio.remove,
    addListener: () => ({ remove: audio.detach }) }),
}));
const boundary = createVoiceSpeechOutputBoundary({ getAccount: () => {
  throw new Error('Installed device preview must not dispatch a daemon RPC');
} });
const { playRealtimeCatalogPreview, readRealtimeCatalogPreview, stopRealtimeCatalogPreview } = await import('./catalogPreview');
const { speakKokoroText } = await import('@/voice/output/KokoroTtsController');
const { t, setPreferredLanguageFromSettings } = await import('@/text');
const packId = 'catalog-preview-kokoro';
const providerId = 'happier.voice.builtin/local-neural';
const synthesize: import('./catalogPreview').VoiceCatalogPreviewSynthesizer = async ({ row, registerPlaybackStopper }) => {
  await speakKokoroText({ text: t('settingsVoice.local.testTtsSample'), assetSetId: packId, voiceId: row.id, speed: 1,
    timeoutMs: 15_000, registerPlaybackStopper });
};
beforeEach(() => {
  const { filesystem } = boundary.reset();
  boundary.platform.value = 'ios';
  setPreferredLanguageFromSettings('en');
  const manifest = parseModelPackManifest({ packId, kind: 'tts_sherpa', model: 'kokoro', version: '1',
    frontend: { lang: 'en' }, voices: [{ id: 'am_adam', title: 'Adam', sid: 0 }], defaultVoiceId: 'am_adam',
    files: [{ path: 'model.onnx', url: 'https://example.test/model.onnx', sha256: 'a'.repeat(64), sizeBytes: 1 }] });
  filesystem.files.set(`${filesystem.root}/${packId}/pack.json`, new TextEncoder().encode(JSON.stringify({ manifest })));
  boundary.nativeListVoices.mockResolvedValue([{ id: 'am_adam', title: 'Adam', sid: 0 }]);
  audio.play.mockClear(); audio.remove.mockClear(); audio.detach.mockClear();
});
afterEach(() => {
  const preview = readRealtimeCatalogPreview();
  if (preview) stopRealtimeCatalogPreview(preview.providerId);
  boundary.disposeNativeSdkBridge();
});
afterAll(async () => { await boundary.disposeAudioSession(); });

describe('the shared catalog preview owner', () => {
  it('previews an installed voice without requiring a remote preview URL', async () => {
    const result = await playRealtimeCatalogPreview({ providerId: 'happier.voice.builtin/local-neural',
      row: { id: 'am_adam', name: 'Adam' }, isCurrent: () => true, synthesize });
    expect(result).toMatchObject({ status: 'completed' });
    expect(boundary.nativeSynthesize).toHaveBeenCalledWith(expect.objectContaining({ voiceId: 'am_adam' }));
    expect(boundary.nativeSynthesize.mock.calls.map(([request]) => request.text).join(' ')).toBe(t('settingsVoice.local.testTtsSample'));
    expect(boundary.encodedAudio.start).toHaveBeenCalled();
    expect(boundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
    expect(readRealtimeCatalogPreview()).toBeNull();
  });

  it('interrupts pending synthesis and cannot publish its late completion', async () => {
    const initialization = createDeferred<void>();
    boundary.nativeInitialize.mockImplementationOnce(() => initialization.promise);
    const pending = playRealtimeCatalogPreview({ providerId, row: { id: 'am_adam', name: 'Adam' },
      isCurrent: () => true, synthesize });
    expect(readRealtimeCatalogPreview()).toEqual({ providerId, voiceId: 'am_adam' });
    await vi.waitFor(() => expect(boundary.nativeInitialize).toHaveBeenCalledOnce());
    expect(stopRealtimeCatalogPreview(providerId)).toBe(true);
    initialization.resolve();
    expect(await pending).toMatchObject({ status: 'cancelled' });
    expect(boundary.nativeCancelInitialization).toHaveBeenCalledOnce();
    expect(boundary.encodedAudio.start).not.toHaveBeenCalled();
    expect(boundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
    expect(readRealtimeCatalogPreview()).toBeNull();
  });

  it('retains URL-based preview playback and stop cleanup for realtime catalogs', async () => {
    const providerId = 'happier.voice.example/realtime';
    expect(await playRealtimeCatalogPreview({ providerId,
      row: { id: 'calm', name: 'Calm', previewUrl: 'https://preview.example.test/calm.wav' },
      isCurrent: () => true })).toMatchObject({ status: 'completed' });
    expect(audio.play).toHaveBeenCalled();
    expect(readRealtimeCatalogPreview()).toEqual({ providerId, voiceId: 'calm' });
    expect(stopRealtimeCatalogPreview(providerId)).toBe(true);
    expect(audio.remove).toHaveBeenCalled();
    expect(audio.detach).toHaveBeenCalled();
    expect(readRealtimeCatalogPreview()).toBeNull();
  });
});

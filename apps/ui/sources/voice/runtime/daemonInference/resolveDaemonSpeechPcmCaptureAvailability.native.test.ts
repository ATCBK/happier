import { describe, expect, it, vi } from 'vitest';
import { createNativeVoicePcmCaptureHarness } from '@/dev/testkit/harness/nativeVoicePcmCapture';

const nativeAudio = createNativeVoicePcmCaptureHarness();
// This app process starts with an older installed native SDK, never a registry
// that turns absent after a successful initial lookup in the same process.
const legacyModule = { start: nativeAudio.nativeModule.start,
    stop: nativeAudio.nativeModule.stop, addListener: nativeAudio.nativeModule.addListener };
vi.mock('expo-modules-core', async original => {
    const actual = await original<typeof import('expo-modules-core')>();
    return { ...actual, requireOptionalNativeModule: (name: string) => name === 'HappierAudioStreamNative'
        ? legacyModule : actual.requireOptionalNativeModule(name) };
});
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { getSharedVoicePcmCapture } = await import('@happier-dev/audio-stream-native');
const { createNativeMicSession } = await import('../mic/NativeMicSession');
const { createDaemonSpeechPcmCapture } = await import('./DaemonSpeechPcmCapture.native');
const { resolveDaemonSpeechPcmCaptureAvailability } = await import('./resolveDaemonSpeechPcmCaptureAvailability.native');

describe('native daemon capture with an installed legacy SDK', () => {
    // The positive forwarding-only row is covered by the actual installed-SDK
    // native pipeline keeper; this file owns the separate legacy-SDK startup.
    it('fails availability and actual capture closed without starting an SDK lacking coordination', async () => {
        expect(getSharedVoicePcmCapture()).toBeNull();
        expect(resolveDaemonSpeechPcmCaptureAvailability()).toBe('unavailable');
        const micSession = createNativeMicSession({ ensurePermission: async () => {} });
        const onError = vi.fn();
        const onAudioStarted = vi.fn();
        const capture = createDaemonSpeechPcmCapture({ micSession, onAudioStarted,
            onChunk: vi.fn(), onError });
        await capture.start();
        expect(capture.isActive()).toBe(false);
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'provider_error', reason: 'daemon_streaming_stt_pcm_capture_unavailable',
        }));
        expect(onAudioStarted).not.toHaveBeenCalled();
        expect(legacyModule.start).not.toHaveBeenCalled();
        await capture.stop();
        await micSession.teardown();
    });
});

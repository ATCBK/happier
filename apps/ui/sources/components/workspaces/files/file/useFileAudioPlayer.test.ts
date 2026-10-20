import * as React from 'react';
import type { AudioPlayer, AudioStatus } from 'expo-audio';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { act, renderHook } from '@/dev/testkit';
import { createNativeVoicePcmCaptureHarness } from '@/dev/testkit/harness/nativeVoicePcmCapture';
import { voiceRuntimeLevelStore } from '@/voice/runtime/levels/voiceRuntimeLevelStore';

const audioSession = createNativeVoicePcmCaptureHarness();
const nativeAudio = vi.hoisted(() => {
    const listeners = new Set<() => void>();
    let status: AudioStatus = {
        id: 'file-audio', currentTime: 0, duration: 30, playbackState: 'readyToPlay',
        timeControlStatus: 'paused', reasonForWaitingToPlay: '', mute: false, playing: false,
        loop: false, didJustFinish: false, isBuffering: false, isLoaded: true,
        playbackRate: 1, shouldCorrectPitch: false,
    };
    const publish = (delta: Partial<AudioStatus>) => {
        status = { ...status, ...delta };
        for (const listener of listeners) listener();
    };
    const player = {
        id: 'file-audio', duration: 30, currentTime: 0,
        play: vi.fn(() => publish({ playing: true })),
        pause: vi.fn(() => publish({ playing: false })),
        seekTo: vi.fn(async (seconds: number) => { player.currentTime = seconds; publish({ currentTime: seconds }); }),
    };
    return { player, read: () => status, publish,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
});

vi.mock('react-native', async () => (
    await import('@/dev/testkit/mocks/reactNative')
).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('expo-audio', async () => (
    await import('@/dev/testkit/mocks/expoAudio')
).expoAudioModuleMock({
    // The SDK's shared-object internals are outside this owning process's logic.
    useAudioPlayer: () => nativeAudio.player as unknown as AudioPlayer,
    useAudioPlayerStatus: () => React.useSyncExternalStore(nativeAudio.subscribe, nativeAudio.read),
}));
vi.mock('expo-modules-core', async (importOriginal) => {
    const original = await importOriginal<typeof import('expo-modules-core')>();
    return { ...original, requireOptionalNativeModule: (name: string) => name === 'HappierAudioStreamNative'
        ? audioSession.nativeModule : original.requireOptionalNativeModule(name) };
});

describe('file audio native controller', () => {
    it('seeks in seconds and uses the canonical audio-session owner while pausing for voice output', async () => {
        const { getSharedVoiceAudioSessionCoordinator } = await import('@happier-dev/audio-stream-native');
        const { useFileAudioPlayer } = await import('./useFileAudioPlayer');
        const hook = await renderHook(() => useFileAudioPlayer({ uri: 'file:///song.mp3', isActive: true }));
        await act(async () => { await hook.getCurrent().play(); await hook.getCurrent().seekTo(20); await hook.getCurrent().seekBy(5); });
        expect(nativeAudio.player.currentTime).toBe(25);
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', playing: true });
        expect(getSharedVoiceAudioSessionCoordinator()?.getSnapshot()).toMatchObject({ leaseCount: 1, configuration: { mode: 'playback' } });
        let voice!: ReturnType<typeof voiceRuntimeLevelStore.open>;
        await act(async () => { voice = voiceRuntimeLevelStore.open({ channel: 'output', sourceId: 'native-file-audio-test' }); });
        onTestFinished(() => voice.close());
        expect(hook.getCurrent()).toMatchObject({ playing: false, playbackAllowed: false });
        expect(getSharedVoiceAudioSessionCoordinator()?.getSnapshot().leaseCount).toBe(0);
        await act(async () => { voice.close(); });
        expect(hook.getCurrent().playing).toBe(false);
        await hook.unmount();
    });
});

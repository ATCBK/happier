import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeechOptions } from 'expo-speech';
import { createDeferred } from '@/dev/testkit';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { readLocalDirectVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { createDefaultLocalVoiceTtsProviderControllers, type LocalVoiceTtsRequest } from './localVoiceTtsProviderControllers';

const speech = vi.hoisted(() => ({ speak: vi.fn<(text: string, options: SpeechOptions) => void>(), stop: vi.fn() }));

// Expo Speech is the native/browser SDK boundary. The provider, speech owner,
// playback stopper and audio-mode acquisition stay real.
vi.mock('expo-speech', () => ({ speak: speech.speak, stop: speech.stop }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});

function request(overrides: Partial<LocalVoiceTtsRequest> = {}): LocalVoiceTtsRequest {
    const config = readLocalDirectVoiceSettings(settingsDefaults.voice);
    return {
        sessionId: 's1',
        text: 'hello there',
        settings: settingsDefaults,
        tts: { ...config.tts, provider: 'device' },
        networkTimeoutMs: config.networkTimeoutMs,
        onSpeaking: vi.fn(),
        registerPlaybackStopper: () => () => {},
        ...overrides,
    };
}

describe('device TTS provider controller', () => {
    beforeEach(() => { speech.speak.mockReset(); speech.stop.mockReset(); });

    it('stops active device speech once when playback is interrupted and releases the stopper', async () => {
        let interrupt: () => void = () => { throw new Error('Playback stopper was not registered'); };
        const clearStopper = vi.fn();
        const onSpeaking = vi.fn();
        const sdkSpeech = createDeferred<void>();
        speech.speak.mockImplementationOnce(() => sdkSpeech.resolve());
        const speaking = createDefaultLocalVoiceTtsProviderControllers().get('device')!.speak(request({
            onSpeaking,
            registerPlaybackStopper: stopper => { interrupt = stopper; return clearStopper; },
        }));
        await sdkSpeech.promise;
        expect(speech.speak).toHaveBeenCalled();
        const options = speech.speak.mock.calls[0][1];
        expect(onSpeaking).not.toHaveBeenCalled();
        options.onStart?.();
        expect(onSpeaking).toHaveBeenCalledOnce();

        interrupt();
        await speaking;

        expect(speech.stop).toHaveBeenCalledOnce();
        expect(clearStopper).toHaveBeenCalledOnce();
        // A late SDK completion cannot emit a second speaking transition.
        options.onStart?.();
        options.onDone?.();
        expect(onSpeaking).toHaveBeenCalledOnce();
    });

    it('skips the speech SDK when interrupted before synthesis and does not publish speaking', async () => {
        const onSpeaking = vi.fn();
        await createDefaultLocalVoiceTtsProviderControllers().get('device')!.speak(request({
            onSpeaking,
            registerPlaybackStopper: stopper => { stopper(); return () => {}; },
        }));

        expect(speech.speak).not.toHaveBeenCalled();
        expect(speech.stop).not.toHaveBeenCalled();
        expect(onSpeaking).not.toHaveBeenCalled();
    });

    it('publishes a recoverable failure when the speech SDK fails before audio starts', async () => {
        speech.speak.mockImplementationOnce((_text, options) => options.onError?.(new Error('device_synth_boom')));
        const onTtsFailed = vi.fn();
        const onSpeaking = vi.fn();
        await createDefaultLocalVoiceTtsProviderControllers().get('device')!.speak(request({ onTtsFailed, onSpeaking }));

        expect(onTtsFailed).toHaveBeenCalledWith(expect.objectContaining({ kind: 'tts_failed', recoverable: true,
            reason: 'device_synth_boom' }));
        expect(onSpeaking).not.toHaveBeenCalled();
    });

    it('does not publish a TTS failure for an SDK abort', async () => {
        speech.speak.mockImplementationOnce((_text, options) => options.onError?.(
            Object.assign(new Error('turn_aborted'), { name: 'AbortError' }),
        ));
        const onTtsFailed = vi.fn();
        await createDefaultLocalVoiceTtsProviderControllers().get('device')!.speak(request({ onTtsFailed }));

        expect(onTtsFailed).not.toHaveBeenCalled();
    });
});

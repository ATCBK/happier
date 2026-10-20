import { vi } from 'vitest';

/** Physical device audio-mode SDK leaf; the voice audio-mode owner stays real. */
export function expoAudioModuleMock(input: Readonly<{
    setAudioModeAsync?: typeof import('expo-audio')['AudioModule']['setAudioModeAsync'];
    requestRecordingPermissionsAsync?: typeof import('expo-audio')['AudioModule']['requestRecordingPermissionsAsync'];
    useAudioPlayer?: typeof import('expo-audio')['useAudioPlayer'];
    useAudioPlayerStatus?: typeof import('expo-audio')['useAudioPlayerStatus'];
}> = {}) {
    return {
        ...(input.useAudioPlayer ? { useAudioPlayer: input.useAudioPlayer } : {}),
        ...(input.useAudioPlayerStatus ? { useAudioPlayerStatus: input.useAudioPlayerStatus } : {}),
        AudioModule: {
            setAudioModeAsync: vi.fn<typeof import('expo-audio')['AudioModule']['setAudioModeAsync']>(input.setAudioModeAsync ?? (async () => {})),
            ...(input.requestRecordingPermissionsAsync ? {
                requestRecordingPermissionsAsync: vi.fn(input.requestRecordingPermissionsAsync),
            } : {}),
        },
    };
}

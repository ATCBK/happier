import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, waitForTestEvent } from '@/dev/testkit';
import type {
    VoiceAudioSessionCoordinator,
    VoiceAudioSessionPlatformEvent,
} from '@happier-dev/audio-stream-native';

import { createDeviceSttController } from '@/voice/input/DeviceSttController';
import { createLocalVoiceCaptureOwner } from '@/voice/runtime/input/LocalVoiceCaptureOwner';
import { createExpoAudioRecordingMicSession } from '@/voice/runtime/mic/NativeMicSession';
import { createNativeMicSession } from '@/voice/runtime/mic/NativeMicSession';
import { createVoiceFileRecording } from '@happier-dev/audio-stream-native';
import { createNativeVoicePcmCaptureHarness } from '@/dev/testkit/harness/nativeVoicePcmCapture';

import { createVoiceDictationController } from './VoiceDictationController';

const nativeBoundary = vi.hoisted(() => ({
    coordinator: null as VoiceAudioSessionCoordinator | null,
    listeners: {} as Record<string, (event: unknown) => void>,
    recognizerStart: vi.fn(),
    recognizerStop: vi.fn(),
}));

vi.mock('@happier-dev/audio-stream-native', async () => {
    const actual = await vi.importActual<typeof import('@happier-dev/audio-stream-native')>(
        '@happier-dev/audio-stream-native',
    );
    return {
        ...actual,
        getSharedVoiceAudioSessionCoordinator: () => nativeBoundary.coordinator,
    };
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
            Version: '18.0',
        },
    });
});

vi.mock('expo-audio', () => ({ AudioModule: {
    requestRecordingPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
} }));

vi.mock('expo-speech-recognition', () => ({
    ExpoSpeechRecognitionModule: {
        addListener: (eventName: string, listener: (event: unknown) => void) => {
            nativeBoundary.listeners[eventName] = listener;
            return {
                remove: () => {
                    if (nativeBoundary.listeners[eventName] === listener) {
                        delete nativeBoundary.listeners[eventName];
                    }
                },
            };
        },
        isRecognitionAvailable: () => true,
        requestPermissionsAsync: async () => ({ granted: true }),
        start: (...args: unknown[]) => nativeBoundary.recognizerStart(...args),
        stop: (...args: unknown[]) => nativeBoundary.recognizerStop(...args),
    },
}));

type NativeLifecycleEventFactory = (
    generation: number,
) => VoiceAudioSessionPlatformEvent;

const TERMINAL_NATIVE_EVENTS: ReadonlyArray<Readonly<{
    label: string;
    createEvent: NativeLifecycleEventFactory;
}>> = [
    {
        label: 'interruption',
        createEvent: (generation) => ({
            generation,
            kind: 'interruption_began',
        }),
    },
    {
        label: 'permanent focus loss',
        createEvent: (generation) => ({
            generation,
            kind: 'focus_changed',
            state: 'lost_permanent',
        }),
    },
    {
        label: 'backgrounding',
        createEvent: (generation) => ({
            generation,
            kind: 'lifecycle_changed',
            state: 'background',
        }),
    },
    {
        // Dictation records through the same native graph. A media-services
        // reset kills it while the attempt still looks like it is listening.
        label: 'dead native audio graph',
        createEvent: (generation) => ({
            generation,
            kind: 'audio_graph_terminal',
            reason: 'media_services_reset',
        }),
    },
];

function createNativeCoordinatorHarness(): Readonly<{
    coordinator: VoiceAudioSessionCoordinator;
    emit: (event: VoiceAudioSessionPlatformEvent) => void;
    restore: ReturnType<typeof vi.fn>;
}> {
    const native = createNativeVoicePcmCaptureHarness();
    return {
        coordinator: native.coordinator,
        emit: native.emitSession,
        restore: native.restore,
    };
}

function createRecordedDictationHarness(
    coordinator: VoiceAudioSessionCoordinator,
) {
    const recorderStop = vi.fn(async () => {});
    const fileRecordingSdk = {
        startFileRecording: vi.fn(async () => ({ recordingId: 'native-dictation' })),
        setFileRecordingMuted: vi.fn(async () => {}),
        stopFileRecording: vi.fn(async () => {
            await recorderStop();
            return { uri: 'file:///native-dictation.m4a' };
        }),
    };
    // The real first-party recorder owns recording identity and terminal state.
    const native = createNativeVoicePcmCaptureHarness();
    const createRecorder = () => createVoiceFileRecording({ ...native.nativeModule, ...fileRecordingSdk });
    const captureOwner = createLocalVoiceCaptureOwner({
        getSettings: () => ({}),
        onCaptureError: vi.fn(),
        onCaptureStarted: vi.fn(),
    }, {
        createRecordingMicSession: () => createExpoAudioRecordingMicSession({
            createNativeFileRecording: createRecorder,
            requestPermission: async () => ({
                granted: true,
                canAskAgain: true,
            }),
        }),
    });
    const controller = createVoiceDictationController({
        captureOwner,
        getSettings: () => ({
            voice: {
                dictation: {
                    sttBinding: 'explicit',
                    language: null,
                    stt: {
                        provider: 'happier.voice.openai-compat/stt',
                    },
                },
            },
        }),
        nativeAudioSessionCoordinator: coordinator,
        measureRecordedAudioBytes: async () => 4,
        deleteRecordedAudio: async () => {},
        transcribeRecordedAudio: vi.fn(),
    });
    return {
        controller,
        createRecorder,
        recorderStop,
    };
}

function createDeviceDictationHarness(
    coordinator: VoiceAudioSessionCoordinator,
) {
    const liveMicSessions: Array<Readonly<{
        teardown: ReturnType<typeof vi.fn>;
    }>> = [];
    const captureOwner = createLocalVoiceCaptureOwner({
        getSettings: () => ({}),
        onCaptureError: vi.fn(),
        onCaptureStarted: vi.fn(),
    }, {
        createDeviceSttController: (deps) => createDeviceSttController({
            ...deps,
            getAudioSessionCoordinator: () => coordinator,
            stopTimeoutMs: 0,
        }),
        createLiveMicSession: () => {
            const microphone = createNativeMicSession();
            const session = { ...microphone, teardown: vi.fn(microphone.teardown) };
            liveMicSessions.push(session);
            return session;
        },
    });
    const controller = createVoiceDictationController({
        captureOwner,
        getSettings: () => ({
            voice: {
                dictation: {
                    sttBinding: 'explicit',
                    language: null,
                    stt: {
                        provider: 'device',
                    },
                },
            },
        }),
        nativeAudioSessionCoordinator: coordinator,
        measureRecordedAudioBytes: async () => 0,
        deleteRecordedAudio: async () => {},
        transcribeRecordedAudio: vi.fn(),
    });
    return {
        controller,
        liveMicSessions,
    };
}

async function proveTerminalLifecycleAndRetry(input: Readonly<{
    controller: ReturnType<typeof createVoiceDictationController>;
    coordinator: VoiceAudioSessionCoordinator;
    emit: (event: VoiceAudioSessionPlatformEvent) => void;
    restore: ReturnType<typeof vi.fn>;
}>): Promise<void> {
    for (const nativeEvent of TERMINAL_NATIVE_EVENTS) {
        await expect(input.controller.toggle('dictation-session')).resolves.toEqual({
            kind: 'started',
        });
        expect(input.coordinator.getSnapshot().leaseCount).toBe(1);
        const currentGeneration = input.coordinator.getSnapshot().generation;

        input.emit(nativeEvent.createEvent(currentGeneration - 1));
        await Promise.resolve();
        expect(input.controller.getSnapshot()).toMatchObject({
            sessionId: 'dictation-session',
            status: 'listening',
        });
        expect(input.coordinator.getSnapshot().leaseCount).toBe(1);

        const restoring = createDeferred<void>();
        input.restore.mockImplementationOnce(async () => { restoring.resolve(); });
        input.emit(nativeEvent.createEvent(currentGeneration));
        await restoring.promise;
        await new Promise<void>(resolve => setImmediate(resolve));
        await waitForTestEvent(input.controller.subscribe, input.controller.getSnapshot, snapshot => snapshot.status === 'idle');
        expect(input.controller.getSnapshot().status).toBe('idle');
        expect(input.coordinator.getSnapshot().leaseCount).toBe(0);

        await expect(input.controller.toggle('dictation-session')).resolves.toEqual({
            kind: 'started',
        });
        expect(input.coordinator.getSnapshot().leaseCount).toBe(1);
        const cancellationRestored = createDeferred<void>();
        input.restore.mockImplementationOnce(async () => { cancellationRestored.resolve(); });
        await input.controller.cancel('dictation-session');
        await cancellationRestored.promise;
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(input.coordinator.getSnapshot().leaseCount).toBe(0);
    }
}

describe('Dictation native audio lifecycle', () => {
    beforeEach(() => {
        nativeBoundary.listeners = {};
        nativeBoundary.recognizerStart.mockReset();
        nativeBoundary.recognizerStop.mockReset();
    });

    afterEach(async () => {
        nativeBoundary.coordinator = null;
    });

    it('settles recorded Dictation on current native terminal facts, ignores stale facts, releases, and retries', async () => {
        const native = createNativeCoordinatorHarness();
        nativeBoundary.coordinator = native.coordinator;
        const dictation = createRecordedDictationHarness(native.coordinator);

        await proveTerminalLifecycleAndRetry({
            controller: dictation.controller,
            coordinator: native.coordinator,
            emit: native.emit,
            restore: native.restore,
        });

        expect(dictation.recorderStop).toHaveBeenCalledTimes(8);
        expect(native.restore).toHaveBeenCalledTimes(8);
        await native.coordinator.dispose();
    });

    it('settles Device Dictation on current native terminal facts, ignores stale facts, releases, and retries', async () => {
        const native = createNativeCoordinatorHarness();
        nativeBoundary.coordinator = native.coordinator;
        const dictation = createDeviceDictationHarness(native.coordinator);

        await proveTerminalLifecycleAndRetry({
            controller: dictation.controller,
            coordinator: native.coordinator,
            emit: native.emit,
            restore: native.restore,
        });

        expect(nativeBoundary.recognizerStop).toHaveBeenCalledTimes(8);
        expect(dictation.liveMicSessions).toHaveLength(8);
        expect(dictation.liveMicSessions.every((session) => (
            session.teardown.mock.calls.length === 1
        ))).toBe(true);
        expect(native.restore).toHaveBeenCalledTimes(8);
        await native.coordinator.dispose();
    });
});

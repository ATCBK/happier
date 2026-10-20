import { readLocalDirectVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { afterAll } from 'vitest';
import { warmLocalVoiceEngineHarnessGraph } from './localVoiceEngine.testHarness';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    expoSpeechSpeak,
    expoSpeechStop,
    emitSpeechRecEvent,
    getStorage,
    loadLocalVoiceEngineWithCompatState,
    registerLocalVoiceEngineHarnessHooks,
    localVoicePendingEnqueue,
    localVoiceSpeechTranscription,
    acknowledgeLocalVoicePendingEnqueue,
    speechRecStart,
    speechRecStop,
    publishLocalVoiceAssistantMessage,
    publishLocalVoiceSubmittedUserMessage,
    setNextRecorderPrepareError,
} from './localVoiceEngine.testHarness';

let localVoiceEngine: Awaited<ReturnType<typeof loadLocalVoiceEngineWithCompatState>>;

async function waitForVoiceStatus(getStatus: () => string, expectedStatus: string) {
    await vi.waitFor(() => {
        expect(getStatus()).toBe(expectedStatus);
    });
}

async function expectPromiseToStayPending(promise: Promise<unknown>) {
    await vi.waitFor(async () => {
        const settled = await Promise.race([
            promise.then(() => true),
            new Promise<boolean>((resolve) => {
                setTimeout(() => resolve(false), 0);
            }),
        ]);
        expect(settled).toBe(false);
    });
}

const restoreHarnessModuleLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => restoreHarnessModuleLoader());

describe('local voice engine TTS behavior', () => {
    registerLocalVoiceEngineHarnessHooks();

    beforeEach(async () => {
        localVoiceEngine = await loadLocalVoiceEngineWithCompatState();
        speechRecStart.mockImplementation(() => emitSpeechRecEvent('audiostart'));
        speechRecStop.mockImplementation(() => emitSpeechRecEvent('end'));
    }, 180_000);

    it.each(['device', 'local_neural'] as const)('supports manual barge-in with the retained device producer after selecting %s STT', async (nextProvider) => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_direct',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_direct: { schemaVersion: 1, config: {
                            ...readLocalDirectVoiceSettings(storage.getState().settings.voice),
                            stt: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).stt,
                                provider: 'device',
                            },
                            tts: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).tts,
                                autoSpeakReplies: true,
                                provider: 'device',
                                bargeInEnabled: true,
                            },
                        } },
                    },
                },
            },
        });

        const settings = storage.getState().settings;
        const onDoneRef: { current: (() => void) | undefined } = { current: undefined };
        const onStoppedRef: { current: (() => void) | undefined } = { current: undefined };
        expoSpeechSpeak.mockImplementation((_text: string, opts: any) => {
            onDoneRef.current = typeof opts?.onDone === 'function' ? (opts.onDone as () => void) : undefined;
            onStoppedRef.current = typeof opts?.onStopped === 'function' ? (opts.onStopped as () => void) : undefined;
            opts?.onStart?.();
        });
        expoSpeechStop.mockImplementation(() => {
            onStoppedRef.current?.();
        });

        localVoicePendingEnqueue.mockImplementation(async request => {
            // Restore the next producer only once Send has consumed and
            // submitted the incumbent device controller's buffered utterance.
            if (localVoicePendingEnqueue.mock.calls.length === 2) storage.__setState({ settings });
            await publishLocalVoiceSubmittedUserMessage(request);
            await publishLocalVoiceAssistantMessage({ sessionId: 's1', id: `m${localVoicePendingEnqueue.mock.calls.length}`, text: 'Hi there' });
            return acknowledgeLocalVoicePendingEnqueue(request);
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'first turn', confidence: 0.9, segments: [] }] });
        const sendTurnPromise = toggleLocalVoiceTurn('s1');
        emitSpeechRecEvent('end', {});

        await waitForVoiceStatus(() => getLocalVoiceState().status, 'speaking');
        expect(getLocalVoiceState().status).toBe('speaking');
        // Initial transcription and playback interruption monitoring each own
        // a native recognition start. Manual barge-in retains the live producer.
        expect(speechRecStart).toHaveBeenCalledTimes(2);

        emitSpeechRecEvent('result', { isFinal: false, results: [{ transcript: 'second turn', confidence: 0.9, segments: [] }] });
        const config = readLocalDirectVoiceSettings(settings.voice);
        storage.__setState({ settings: { ...settings, voice: { ...settings.voice, providers: {
            ...settings.voice.providers,
            local_direct: { schemaVersion: 1, config: { ...config, stt: { ...config.stt, provider: nextProvider } } },
        } } } });
        await toggleLocalVoiceTurn('s1');
        await sendTurnPromise;

        expect(expoSpeechStop).toHaveBeenCalledTimes(1);
        expect(getLocalVoiceState().status).toBe('recording');
        expect(speechRecStart).toHaveBeenCalledTimes(2);
        emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'second turn', confidence: 0.9, segments: [] }] });
        const secondTurn = toggleLocalVoiceTurn('s1');
        await vi.waitFor(() => expect(localVoicePendingEnqueue.mock.calls[1]?.[0]).toMatchObject({ sessionId: 's1', body: {
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'second turn' } } },
        } }));
        await waitForVoiceStatus(() => getLocalVoiceState().status, 'speaking');
        expect(localVoicePendingEnqueue).toHaveBeenCalledTimes(2);
        onDoneRef.current?.();
        await secondTurn;
    });

    it('does not interrupt speaking when barge-in is disabled', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_direct',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_direct: { schemaVersion: 1, config: {
                            ...readLocalDirectVoiceSettings(storage.getState().settings.voice),
                            stt: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).stt,
                                provider: 'device',
                            },
                            tts: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).tts,
                                autoSpeakReplies: true,
                                provider: 'device',
                                bargeInEnabled: false,
                            },
                        } },
                    },
                },
            },
        });

        const onDoneRef: { current: (() => void) | undefined } = { current: undefined };
        const onStoppedRef: { current: (() => void) | undefined } = { current: undefined };
        expoSpeechSpeak.mockImplementation((_text: string, opts: any) => {
            onDoneRef.current = typeof opts?.onDone === 'function' ? (opts.onDone as () => void) : undefined;
            onStoppedRef.current = typeof opts?.onStopped === 'function' ? (opts.onStopped as () => void) : undefined;
            opts?.onStart?.();
        });
        expoSpeechStop.mockImplementation(() => {
            onStoppedRef.current?.();
        });

        localVoicePendingEnqueue.mockImplementationOnce(async request => {
            await publishLocalVoiceSubmittedUserMessage(request);
            await publishLocalVoiceAssistantMessage({ sessionId: 's1', id: 'm1', text: 'Hi there' });
            return acknowledgeLocalVoicePendingEnqueue(request);
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'first turn', confidence: 0.9, segments: [] }] });
        const sendTurnPromise = toggleLocalVoiceTurn('s1');
        emitSpeechRecEvent('end', {});

        await waitForVoiceStatus(() => getLocalVoiceState().status, 'speaking');
        expect(getLocalVoiceState().status).toBe('speaking');

        await toggleLocalVoiceTurn('s1');

        expect(expoSpeechStop).not.toHaveBeenCalled();
        expect(speechRecStart).toHaveBeenCalledTimes(1);
        expect(getLocalVoiceState().status).toBe('speaking');

        onDoneRef.current?.();
        await sendTurnPromise;
    });

    it.each([false, true])('acquires a missing recorded-audio producer after manual interruption and preserves startup failure recovery (fails=%s)', async fails => {
        const storage = await getStorage();
        const config = readLocalDirectVoiceSettings(storage.getState().settings.voice);
        storage.__setState({ settings: { ...storage.getState().settings, voice: {
            ...storage.getState().settings.voice, providerId: 'local_direct', providers: {
                ...storage.getState().settings.voice.providers,
                local_direct: { schemaVersion: 1, config: { ...config,
                    stt: { ...config.stt, provider: 'happier.voice.openai-compat/stt' },
                    tts: { ...config.tts, provider: 'device', autoSpeakReplies: true, bargeInEnabled: true },
                } },
            },
        } } });
        let stopPlayback: (() => void) | undefined;
        expoSpeechSpeak.mockImplementation((_text, options) => {
            stopPlayback = options.onStopped;
            options.onStart?.();
        });
        expoSpeechStop.mockImplementation(() => stopPlayback?.());
        localVoiceSpeechTranscription.mockResolvedValueOnce('first turn');
        localVoicePendingEnqueue.mockImplementationOnce(async request => {
            await publishLocalVoiceSubmittedUserMessage(request);
            await publishLocalVoiceAssistantMessage({ sessionId: 's1', id: 'recorded-reply', text: 'Hi there' });
            return acknowledgeLocalVoicePendingEnqueue(request);
        });
        await localVoiceEngine.toggleLocalVoiceTurn('s1');
        const sentTurn = localVoiceEngine.toggleLocalVoiceTurn('s1');
        await waitForVoiceStatus(() => localVoiceEngine.getLocalVoiceState().status, 'speaking');
        if (fails) setNextRecorderPrepareError(new Error('manual rearm preparation failed'));
        const interrupted = localVoiceEngine.toggleLocalVoiceTurn('s1');
        if (fails) {
            await expect(interrupted).rejects.toThrow('manual rearm preparation failed');
            expect(localVoiceEngine.getLocalVoiceState()).toMatchObject({ status: 'idle', error: 'recording_start_failed' });
            // Failed startup releases the same admission so a fresh Start can recover.
            await localVoiceEngine.toggleLocalVoiceTurn('s1');
        } else {
            await interrupted;
        }
        await sentTurn;
        expect(expoSpeechStop).toHaveBeenCalledTimes(1);
        expect(localVoiceEngine.getLocalVoiceState().status).toBe('recording');
    });

    it('does not auto-speak when sending fails', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_direct',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_direct: { schemaVersion: 1, config: {
                            ...readLocalDirectVoiceSettings(storage.getState().settings.voice),
                            tts: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).tts,
                                autoSpeakReplies: true,
                                provider: 'happier.voice.openai-compat/tts',
                            },
                        } },
                    },
                },
            },
        });

        localVoiceSpeechTranscription.mockResolvedValueOnce('hello world');

        localVoicePendingEnqueue.mockResolvedValueOnce(Response.json({ error: 'send failed' }, { status: 400 }));

        const { toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).rejects.toBeInstanceOf(Error);

        expect(localVoiceSpeechTranscription).toHaveBeenCalledTimes(1);
        expect(expoSpeechSpeak).not.toHaveBeenCalled();
        expect(localVoiceEngine.getLocalVoiceState()).toMatchObject({ status: 'idle', error: 'send_failed' });
    });

});

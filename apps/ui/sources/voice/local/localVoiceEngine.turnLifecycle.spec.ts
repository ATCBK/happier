import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    expoSpeechSpeak,
    getStorage,
    registerLocalVoiceEngineHarnessHooks,
    submitMessage,
} from './localVoiceEngine.testHarness';

let localVoiceEngine: typeof import('./localVoiceEngine');

function liveSession(overrides: Record<string, unknown>) {
    const now = Date.now();
    return { id: 's1', active: true, activeAt: now, presence: 'online', thinking: false, thinkingAt: 0, metadata: null, ...overrides };
}

async function configureDirectVoice(params: Readonly<{ autoSpeakReplies: boolean }>) {
    const storage = await getStorage();
    const settings = storage.getState().settings;
    storage.__setState({
        settings: {
            ...settings,
            voice: {
                ...settings.voice,
                providerId: 'local_direct',
                adapters: {
                    ...settings.voice.adapters,
                    local_direct: {
                        ...settings.voice.adapters.local_direct,
                        tts: {
                            ...settings.voice.adapters.local_direct.tts,
                            autoSpeakReplies: params.autoSpeakReplies,
                            provider: 'device',
                        },
                    },
                },
            },
        },
        sessions: { s1: liveSession({ latestTurnId: 'turn-0', latestTurnStatus: 'completed', latestTurnStatusObservedAt: Date.now() - 5_000 }) },
        sessionMessages: { s1: { messages: [] } },
    });
    (globalThis.fetch as any).mockResolvedValue({ ok: true, json: async () => ({ text: 'run the tests' }) });
    return storage;
}

function setTurn(storage: any, status: 'in_progress' | 'completed', messages: any[]) {
    storage.__setState({
        sessions: { s1: liveSession({ latestTurnId: 'turn-1', latestTurnStatus: status, latestTurnStatusObservedAt: Date.now() }) },
        sessionMessages: { s1: { messages } },
    });
    storage.__notify();
}

describe('local voice engine turn lifecycle (direct session)', () => {
    registerLocalVoiceEngineHarnessHooks();

    beforeEach(async () => {
        localVoiceEngine = await import('./localVoiceEngine');
    }, 180_000);

    it('speaks the final reply of the turn instead of thinking or interim text', async () => {
        const storage = await configureDirectVoice({ autoSpeakReplies: true });
        expoSpeechSpeak.mockImplementation((_text: string, opts: any) => opts?.onDone?.());
        submitMessage.mockImplementationOnce(() => {
            setTurn(storage, 'in_progress', [
                { id: 't1', kind: 'agent-text', text: 'thinking about it', isThinking: true },
                { id: 'a1', kind: 'agent-text', text: 'Let me run them.' },
            ]);
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        const turnPromise = toggleLocalVoiceTurn('s1');
        await vi.waitFor(() => expect(submitMessage).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(expoSpeechSpeak).not.toHaveBeenCalled();

        setTurn(storage, 'completed', [
            { id: 't1', kind: 'agent-text', text: 'thinking about it', isThinking: true },
            { id: 'a1', kind: 'agent-text', text: 'Let me run them.' },
            { id: 'tc1', kind: 'tool-call', tool: { name: 'Bash' } },
            { id: 'a2', kind: 'agent-text', text: 'All tests pass.' },
        ]);
        await turnPromise;

        expect(expoSpeechSpeak).toHaveBeenCalledTimes(1);
        expect(expoSpeechSpeak.mock.calls[0]?.[0]).toBe('All tests pass.');
        expect(getLocalVoiceState()).toMatchObject({ status: 'idle', sessionId: 's1' });
    });

    it('does not restore the voice session when the user hangs up while the reply is speaking', async () => {
        const storage = await configureDirectVoice({ autoSpeakReplies: true });
        const onDoneRef: { current: (() => void) | undefined } = { current: undefined };
        expoSpeechSpeak.mockImplementation((_text: string, opts: any) => {
            onDoneRef.current = opts?.onDone;
        });
        submitMessage.mockImplementationOnce(() => {
            setTurn(storage, 'completed', [{ id: 'a1', kind: 'agent-text', text: 'Done.' }]);
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState, stopLocalVoiceSession } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        const turnPromise = toggleLocalVoiceTurn('s1');
        await vi.waitFor(() => expect(getLocalVoiceState().status).toBe('speaking'));

        await stopLocalVoiceSession();
        expect(getLocalVoiceState()).toMatchObject({ status: 'idle', sessionId: null });
        // The platform reports playback completion only after the hang-up finished.
        onDoneRef.current?.();
        await turnPromise;

        expect(getLocalVoiceState()).toMatchObject({ status: 'idle', sessionId: null });
    });

    it('ignores a mic tap while the reply is pending instead of recording after the turn', async () => {
        const storage = await configureDirectVoice({ autoSpeakReplies: true });
        submitMessage.mockImplementationOnce(() => {
            setTurn(storage, 'in_progress', []);
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        const turnPromise = toggleLocalVoiceTurn('s1');
        await vi.waitFor(() => expect(getLocalVoiceState().status).toBe('sending'));

        const tapPromise = toggleLocalVoiceTurn('s1');
        setTurn(storage, 'completed', []);
        await turnPromise;
        await tapPromise;

        expect(getLocalVoiceState()).toMatchObject({ status: 'idle', sessionId: 's1' });
    });

    it('surfaces a send failure with its root message without rejecting the turn', async () => {
        await configureDirectVoice({ autoSpeakReplies: false });
        submitMessage.mockRejectedValueOnce(new Error('session is offline'));

        const { toggleLocalVoiceTurn, getLocalVoiceState } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();

        expect(getLocalVoiceState()).toMatchObject({
            status: 'idle',
            sessionId: 's1',
            error: 'send_failed',
            errorMessage: 'session is offline',
        });
    });
});

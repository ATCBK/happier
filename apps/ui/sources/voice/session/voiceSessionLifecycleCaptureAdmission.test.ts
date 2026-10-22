import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenAiVoiceRuntimeEnvironment } from '@/dev/testkit/harness/openAiVoiceRuntime';
import { installVoiceWebRtcBrowserBoundary, TestVoiceAudioContext } from '@/dev/testkit/harness/voiceWebRtcHarness';

// Only the physical browser/framework and Account network boundaries are replaced.
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ Platform: { OS: 'web' } }));
vi.mock('expo-router', async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/', params: {}, segments: [] }).module);

// Load the real application graph during collection, as the composed controller
// suite does, so the first capture case measures admission rather than imports.
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();

const pendingBoundaries = new Set<() => void>();

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    const release = () => { pendingBoundaries.delete(release); resolve(); };
    pendingBoundaries.add(release);
    return { promise, resolve: release };
}

describe('Voice session lifecycle capture admission', () => {
    let environment: Awaited<ReturnType<typeof createOpenAiVoiceRuntimeEnvironment>>;
    const fixtures: Array<Readonly<{
        lifecycle: ReturnType<typeof import('./voiceSessionLifecycleController')['createVoiceSessionLifecycleController']>;
        runtime: Awaited<ReturnType<Awaited<ReturnType<typeof createOpenAiVoiceRuntimeEnvironment>>['createRuntime']>>;
        browser: ReturnType<typeof installVoiceWebRtcBrowserBoundary>;
    }>> = [];

    beforeEach(async () => {
        environment = await createOpenAiVoiceRuntimeEnvironment();
    });
    afterEach(async () => {
        // An assertion failure must not strand a held physical SDK operation.
        for (const release of [...pendingBoundaries]) release();
        const { setVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
        setVoiceSessionLifecycleController(null);
        for (const fixture of fixtures.splice(0).reverse()) {
            await fixture.lifecycle.dispose();
            await fixture.runtime.runtime.dispose();
            fixture.runtime.hostLease.revoke();
            fixture.browser.restore();
        }
        await environment?.dispose();
    });

    async function createHarness(onCreatePeer?: NonNullable<Parameters<typeof installVoiceWebRtcBrowserBoundary>[0]>['onCreatePeer']) {
        const [
            { createVoiceCaptureAdmissionController },
            { createVoiceSessionLifecycleController },
        ] = await Promise.all([
            import('@/voice/runtime/input/VoiceCaptureAdmissionController'),
            import('./voiceSessionLifecycleController'),
        ]);
        const audioContext = new TestVoiceAudioContext();
        // AudioContext is an OS/browser object. Real WebMicSession owns its lifecycle.
        const browser = installVoiceWebRtcBrowserBoundary({
            createAudioContext: () => audioContext as unknown as AudioContext,
            onCreatePeer,
        });
        const runtime = await environment.createRuntime(browser);
        const captureAdmission = createVoiceCaptureAdmissionController();
        const lifecycle = createVoiceSessionLifecycleController({ captureAdmission });
        lifecycle.setConfiguredProviderId(runtime.adapter.id);
        const fixture = { audioContext, browser, runtime, captureAdmission, lifecycle };
        fixtures.push(fixture);
        return fixture;
    }

    async function connect(fixture: Awaited<ReturnType<typeof createHarness>>) {
        const starting = fixture.lifecycle.toggle(null);
        await vi.waitFor(() => expect(fixture.browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events'));
        fixture.browser.peer.channel.open();
        await starting;
        expect(fixture.lifecycle.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
        expect(fixture.browser.micSession.getStream()).not.toBeNull();
    }

    function expectAdmissionReleased(fixture: Awaited<ReturnType<typeof createHarness>>) {
        const dictation = fixture.captureAdmission.acquire('dictation');
        expect(dictation.status).toBe('acquired');
        if (dictation.status === 'acquired') dictation.lease.release();
    }

    it('cancels held input when a suspension arrives while user Mute is already applied', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const current = storage.getState().settings.voice;
        const provider = current.providers[environment.entry.providerId]!;
        await environment.configureVoice({
            ...current,
            providers: { ...current.providers, [environment.entry.providerId]: {
                ...provider, config: { ...provider.config as Readonly<Record<string, unknown>>, turnDetection: 'manual' },
            } },
        });
        const fixture = await createHarness();
        const { lifecycle, browser, runtime } = fixture;
        const { executeVoiceConversationAction } = await import('@/sync/ops/actions/voiceConversationAction');
        const { setVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
        const { getVoiceSessionAttemptId, setVoiceSessionSnapshot } = await import('./voiceSessionStore');
        setVoiceSessionLifecycleController(lifecycle);
        const unsubscribe = lifecycle.subscribe(() => setVoiceSessionSnapshot(lifecycle.getSnapshot()));
        const previousHoldEnabled = storage.getState().localSettings.voiceHoldToTalkEnabled;
        storage.setState(state => ({ localSettings: { ...state.localSettings, voiceHoldToTalkEnabled: true } }));
        try {
            await connect(fixture);
            const expectedAttempt = getVoiceSessionAttemptId()!;
            expect(expectedAttempt).not.toBeNull();
            const invoke = (action: Parameters<typeof executeVoiceConversationAction>[0]) =>
                executeVoiceConversationAction(action, { expectedAttempt }, { navigate() {} });
            expect((await executeVoiceConversationAction('ui.voice_global.set_muted',
                { expectedAttempt, muted: true }, { navigate() {} })).status).toBe('completed');
            expect((await invoke('ui.voice_global.hold_begin')).status).toBe('completed');
            await vi.waitFor(() => expect(browser.micTrack.enabled).toBe(true));
            const suspension = await lifecycle.suspendInput(runtime.controlSessionId);
            expect(suspension).not.toBeNull();
            expect(browser.micTrack.enabled).toBe(false);
            expect(lifecycle.beginHoldToTalk(runtime.controlSessionId)).toBeNull();
            await invoke('ui.voice_global.hold_release');
            await suspension!.release();
            expect(browser.micTrack.enabled).toBe(false);
            expect(lifecycle.getSnapshot().micMuted).toBe(true);
            expect(browser.peer.channel.sent.map(value => JSON.parse(value))
                .filter(event => event.type === 'input_audio_buffer.commit')).toEqual([]);
        } finally {
            storage.setState(state => ({ localSettings: { ...state.localSettings, voiceHoldToTalkEnabled: previousHoldEnabled } }));
            unsubscribe();
        }
    });

    it('rejects conversational Voice before its realtime mic owner starts when Dictation started first', async () => {
        const fixture = await createHarness();
        const dictation = fixture.captureAdmission.acquire('dictation');
        if (dictation.status !== 'acquired') throw new Error('expected Dictation admission');
        const { log } = await import('@/log');
        const logStart = log.getCount();
        try {
            await expect(fixture.lifecycle.toggle(null)).rejects.toMatchObject({
                name: 'VoiceCaptureBusyError', code: 'voice_capture_busy_dictation', activeOwner: 'dictation',
            });
            expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
            expect(fixture.browser.peers).toEqual([]);
            const records = log.getLogs().slice(logStart).filter(line => line.startsWith('[voiceRuntimeFailure]'));
            expect(records.some(line => line.includes('voice_capture_busy_dictation'))).toBe(true);
        } finally {
            dictation.lease.release();
        }
    });

    it('keeps End controls or released input, and retains admission through teardown and concurrent disposal', async () => {
        const fixture = await createHarness();
        await connect(fixture);
        const cleanup = deferred();
        fixture.audioContext.close.mockImplementationOnce(() => cleanup.promise);
        expect(fixture.captureAdmission.acquire('dictation')).toEqual({ status: 'busy', activeOwner: 'conversation' });

        const stopping = fixture.lifecycle.stop(fixture.runtime.controlSessionId);
        expect(fixture.lifecycle.getSnapshot().canStop || fixture.browser.micTrack.readyState === 'ended').toBe(true);
        const disposal = fixture.lifecycle.dispose();
        await vi.waitFor(() => expect(fixture.audioContext.close).toHaveBeenCalledOnce());
        expect(fixture.captureAdmission.acquire('dictation')).toEqual({ status: 'busy', activeOwner: 'conversation' });
        cleanup.resolve();
        await Promise.all([stopping, disposal]);
        expect(fixture.browser.micTrack.stop).toHaveBeenCalledOnce();
        expect(fixture.audioContext.close).toHaveBeenCalledOnce();
        expectAdmissionReleased(fixture);
    });

    it('stops an admitted realtime adapter when disposal races its pending start', async () => {
        const remoteDescription = deferred();
        const cleanup = deferred();
        const fixture = await createHarness(peer => {
            peer.setRemoteDescription.mockImplementationOnce(() => remoteDescription.promise);
        });
        fixture.audioContext.close.mockImplementationOnce(() => cleanup.promise);
        const starting = fixture.lifecycle.toggle(null);
        await vi.waitFor(() => expect(fixture.browser.peer.setRemoteDescription).toHaveBeenCalledOnce());
        expect(fixture.browser.micSession.getStream()).not.toBeNull();
        const disposal = fixture.lifecycle.dispose();
        await vi.waitFor(() => expect(fixture.audioContext.close).toHaveBeenCalledOnce());
        expect(fixture.captureAdmission.acquire('dictation')).toEqual({ status: 'busy', activeOwner: 'conversation' });
        expect(fixture.browser.micTrack.stop).toHaveBeenCalledOnce();
        remoteDescription.resolve();
        cleanup.resolve();
        await Promise.all([starting, disposal]);
        expect(fixture.browser.micSession.getStream()).toBeNull();
        expectAdmissionReleased(fixture);
    });

    it('releases after acquisition failure and terminal loss, but retains admission through lifecycle disposal teardown', async () => {
        const fixture = await createHarness();
        vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(
            new DOMException('Microphone denied by browser', 'NotAllowedError'));
        await fixture.lifecycle.toggle(null);
        expect(fixture.lifecycle.getSnapshot()).toMatchObject({ status: 'error', canStop: false });
        expect(fixture.browser.micSession.getStream()).toBeNull();
        expectAdmissionReleased(fixture);

        await connect(fixture);
        fixture.browser.micTrack.dispatchEvent(new Event('ended'));
        await vi.waitFor(() => expect(fixture.lifecycle.getSnapshot()).toMatchObject({
            status: 'disconnected', canStop: false, errorRecoveryAction: 'reconnect',
        }));
        expectAdmissionReleased(fixture);

        // A fresh physical browser device and generated activation replace the terminal carrier.
        const next = await createHarness();
        await connect(next);
        const cleanup = deferred();
        next.audioContext.close.mockImplementationOnce(() => cleanup.promise);
        const disposal = next.lifecycle.dispose();
        await vi.waitFor(() => expect(next.audioContext.close).toHaveBeenCalledOnce());
        expect(next.captureAdmission.acquire('dictation')).toEqual({ status: 'busy', activeOwner: 'conversation' });
        cleanup.resolve();
        await disposal;
        expect(next.browser.micSession.getStream()).toBeNull();
        expectAdmissionReleased(next);
    });

    it('releases a terminal error owner and lets Retry start a fresh realtime attempt', async () => {
        const fixture = await createHarness();
        await connect(fixture);
        // A peer failure is automatically reconnected, not a terminal Retry
        // outcome. The provider's strict session-expired wire fact is terminal.
        fixture.browser.peer.channel.message(JSON.stringify({
            type: 'error', event_id: 'capture-admission-terminal-session',
            error: { code: 'session_expired', message: 'Session expired' },
        }));
        await vi.waitFor(() => expect(fixture.lifecycle.getSnapshot()).toMatchObject({
            status: 'error', canStop: false, errorCode: 'voice_session_expired', errorRecoveryAction: 'retry',
        }));
        expectAdmissionReleased(fixture);
        expect(fixture.browser.micTrack.stop).toHaveBeenCalledOnce();

        const { TestVoiceWebRtcPeer } = await import('@/dev/testkit/harness/voiceWebRtcHarness');
        const nextPeer = new TestVoiceWebRtcPeer();
        vi.mocked(globalThis.RTCPeerConnection).mockImplementationOnce(() => nextPeer as unknown as RTCPeerConnection);
        const retrying = fixture.lifecycle.toggle(null);
        await vi.waitFor(() => expect(nextPeer.createDataChannel).toHaveBeenCalledWith('oai-events'));
        nextPeer.channel.open();
        await retrying;
        expect(fixture.lifecycle.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
        expect(nextPeer.close).not.toHaveBeenCalled();
        // The already retired transport must not receive an obsolete Stop during Retry.
        expect(fixture.browser.peer.close).toHaveBeenCalledOnce();
        expect(fixture.captureAdmission.acquire('dictation')).toEqual({ status: 'busy', activeOwner: 'conversation' });
    });
});

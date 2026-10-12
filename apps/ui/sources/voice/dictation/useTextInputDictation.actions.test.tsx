import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineFixture, createRootLayoutFeaturesResponse, renderHook, standardCleanup } from '@/dev/testkit';
import { createTransferRecipientKeyPair } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption';
import { ApprovalRequestSchema } from '@happier-dev/protocol';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

const recording = vi.hoisted(() => ({ starts: 0, stops: 0 }));
const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: '/session/words', segments: ['(app)', 'session', '[id]'], params: { id: 'words' },
}).module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// Substitute the browser recorder only; capture admission, Dictation and field delivery remain real.
vi.mock('@/voice/runtime/input/LocalVoiceCaptureOwner', async importOriginal => {
    const real = await importOriginal<typeof import('@/voice/runtime/input/LocalVoiceCaptureOwner')>();
    return { ...real, createLocalVoiceCaptureOwner: (deps: Parameters<typeof real.createLocalVoiceCaptureOwner>[0]) =>
        real.createLocalVoiceCaptureOwner(deps, { createRecordingMicSession: () => ({
            ensureActive: async () => {}, setMuted() {}, isMuted: () => false, teardown: async () => {}, getStream: () => null,
            beginRecording: async () => { recording.starts += 1; },
            stopRecording: async () => { recording.stops += 1; return 'blob:dictation-action'; },
        }) }) };
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async importOriginal => ({
    ...await importOriginal<typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc')>(),
    machineRpcWithServerScope: (...args: unknown[]) => machineRpc(...args),
}));

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { storage } = await import('@/sync/domains/state/storage');
const { voiceSettingsParse } = await import('@/sync/domains/settings/voiceSettings');
const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { resolveRuntimeFeatureDecision } = await import('@/sync/domains/features/featureDecisionInputs');
const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { CurrentUiContextProvider, useOptionalCurrentUiContextReader } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
const { createCurrentUiContextVoiceToolPort } = await import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort');
const { registerCurrentUiContextActionPort } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { useTextInputDictation } = await import('./useTextInputDictation');
const { voiceDictationController } = await import('./useVoiceDictation');
let unregister: (() => void) | undefined;

function ActionPort() {
    const reader = useOptionalCurrentUiContextReader();
    React.useEffect(() => {
        if (!reader) return;
        unregister = registerCurrentUiContextActionPort((surface, hostAction) => createCurrentUiContextVoiceToolPort({
            reader, invocationSurface: surface, hostAction, readProjection: () => null, readNavigationBinding: () => null,
        }));
        return unregister;
    }, [reader]);
    return null;
}

afterEach(async () => {
    await voiceDictationController.cancel();
    unregister?.(); unregister = undefined;
    await standardCleanup(); resetRuntimeFetch(); resetServerFeaturesClientForTests(); vi.unstubAllGlobals();
    machineRpc.mockReset(); recording.starts = 0; recording.stops = 0;
});

describe('mounted field Dictation Actions', () => {
    it('captures only after approval, inserts editable words without Send, and refuses an unmounted field', async () => {
        await home.reset();
        const serverUrl = 'https://dictation-action.test';
        const serverId = await home.addHome({ name: 'Dictation Home', serverUrl, serverIdentityId: 'dictation-home', accountId: 'alice', currentAccount: true });
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'alice' };
        publishAppliedActiveServerSnapshot({ serverId, serverUrl, generation: 0 });
        const features = createRootLayoutFeaturesResponse({ features: {
            voice: { enabled: true, happierVoice: { enabled: false } },
            machines: { enabled: true, liveStream: { enabled: true } },
        } });
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        home.answer(serverId, '/v1/features', { body: features });
        home.answer(serverId, '/v1/features/authenticated', { body: features });
        home.answer(serverId, '/v1/kv/bulk', { body: { values: [] } });
        storage.setState({ settingsScope: scope, profileScope: scope });
        storage.getState().applySettingsForScope(scope, { ...storage.getState().settings, experiments: true,
            featureToggles: { ...storage.getState().settings.featureToggles, voice: true, 'voice.agent': true,
                'execution.runs': true, 'voice.daemonInference': true },
            voice: voiceSettingsParse({ providerId: 'off', executionMachine: { mode: 'fixed', machineId: 'speech-machine' },
                dictation: { sttBinding: 'explicit', stt: { provider: 'local_neural', localNeural: { execution: 'daemon' } } } }),
        }, 1);
        storage.setState({ machines: { 'speech-machine': createMachineFixture({ id: 'speech-machine', active: true, activeAt: Date.now() }) } });
        expect(storage.getState().settingsScope).toEqual(scope);
        expect(storage.getState().settings.featureToggles.voice).toBe(true);
        expect(await resolveRuntimeFeatureDecision({ featureId: 'voice.daemonInference' })).toMatchObject({ state: 'enabled' });
        const blob = new Blob(['spoken-words'], { type: 'audio/webm' });
        setRuntimeFetch(async (url, init) => String(url) === 'blob:dictation-action'
            ? new Response(blob) : home.request(url, init));
        let permission: 'prompt' | 'granted' = 'prompt';
        vi.stubGlobal('navigator', { permissions: { query: async () => ({ state: permission }) } });
        const recipient = createTransferRecipientKeyPair();
        machineRpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.endsWith('upload.init')) return { success: true, uploadId: 'dictation-upload', chunkSizeBytes: 65536, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 };
            if (method.endsWith('upload.chunk') || method.endsWith('upload.abort')) return { success: true };
            if (method.endsWith('upload.finalize')) return { success: true, uploadId: 'dictation-upload', path: '/tmp/dictation.webm', sizeBytes: blob.size, sha256: 'abc' };
            if (method.endsWith('stt.transcribe')) return { ok: true, requestId: 'dictation-request', text: 'editable words', language: 'en', modelPackId: null };
            throw new Error(`Unexpected Dictation RPC: ${method}`);
        });
        const credentials = (await TokenStorage.getCredentialsForServerUrl(serverUrl))!;
        const wrapper = ({ children }: React.PropsWithChildren) => <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider><ActionPort />{children}</CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
        let words = 'draft';
        const field = await renderHook(() => useTextInputDictation({ controlId: 'mounted-field', enabled: true,
            presented: true, editable: true, transcriptionSessionId: null, onTranscription: text => { words += ` ${text}`; } }), { wrapper });
        let focused: Promise<boolean> | undefined;
        await act(async () => { focused = field.getCurrent().onFocus(); });
        expect(await focused).toBe(true);
        const executor = createDefaultActionExecutor();
        const execute = async (...args: Parameters<typeof executor.execute>) => {
            let result: Awaited<ReturnType<typeof executor.execute>> | undefined;
            await act(async () => { result = await executor.execute(...args); });
            if (!result) throw new Error('Action did not settle');
            return result;
        };
        const ui = { surface: 'ui' as const, authority: 'present_user' as const, serverId, expectedAccountId: 'alice' };
        const agent = { ...ui, surface: 'agent' as const, authority: 'account_automation' as const,
            actionRequestId: 'dictation-start-request', defaultSessionMachineId: 'speech-machine' } satisfies ActionExecutorContext;
        const read = await execute('ui.current_context.read', {}, ui);
        expect(read).toMatchObject({ ok: true, result: { commands: expect.arrayContaining([expect.objectContaining({ title: expect.any(String) })]) } });
        if (!read.ok || !read.result || typeof read.result !== 'object' || !('commands' in read.result)) throw new Error('Dictation commands absent');
        const commands = read.result.commands as readonly { id: string; title: string }[];
        expect(commands).toHaveLength(4);
        const start = commands[0]!.id;
        const finish = commands[1]!.id;
        const cancel = commands[2]!.id;
        const consent = await execute('ui.voice_global.dictation.start', { commandId: start }, ui);
        expect(consent, JSON.stringify(consent))
            .toMatchObject({ ok: true, result: { status: 'unavailable', code: 'dictation_consent_required' } });
        expect(recording.starts).toBe(0);
        permission = 'granted';
        const approvalWait = new AbortController();
        const requested = executor.execute('ui.current_context.command.invoke', { commandId: start }, { ...agent, signal: approvalWait.signal });
        try {
            const approval = await waitForHomeGovernance(() => {
                const row = home.artifacts(serverId).list().find(item => {
                    const body = home.artifacts(serverId).readPlainBody(item.id);
                    return body !== null && ApprovalRequestSchema.safeParse(JSON.parse(body)).success;
                });
                expect(row).toBeDefined();
                return row!;
            });
            expect(JSON.parse(home.artifacts(serverId).readPlainBody(approval.id) ?? 'null'))
                .toMatchObject({ actionId: 'ui.voice_global.dictation.start', status: 'open',
                    executionOriginV1: { machineId: 'speech-machine' } });
            expect(recording.starts).toBe(0);
            const decided = await execute('approval.request.decide', { artifactId: approval.id, decision: 'approve' }, ui);
            expect(decided, JSON.stringify(decided))
                .toMatchObject({ ok: true, result: { status: 'approved' } });
            expect(await requested).toMatchObject({ ok: true, result: { status: 'completed', dictationStatus: 'listening' } });
        } finally {
            approvalWait.abort();
            await requested;
        }
        expect(voiceDictationController.getSnapshot()).toMatchObject({ sessionId: 'mounted-field', status: 'listening' });
        const finished = await execute('ui.current_context.command.invoke', { commandId: finish }, agent);
        expect(finished, JSON.stringify({ finished, snapshot: voiceDictationController.getSnapshot(),
            methods: machineRpc.mock.calls.map(([request]) => request.method) }))
            .toMatchObject({ ok: true, result: { status: 'completed', dictationStatus: 'idle', inserted: true } });
        expect(words).toBe('draft editable words');
        expect(home.requests.some(request => request.path.includes('/pending') || request.path.includes('/messages'))).toBe(false);
        expect(await execute('ui.voice_global.dictation.start', { commandId: start }, ui))
            .toMatchObject({ ok: true, result: { status: 'completed', dictationStatus: 'listening' } });
        expect(await execute('ui.current_context.command.invoke', { commandId: cancel }, agent))
            .toMatchObject({ ok: true, result: { status: 'completed', dictationStatus: 'idle', inserted: false } });
        expect(words).toBe('draft editable words');
        await field.unmount();
        expect(await execute('ui.voice_global.dictation.start', { commandId: start }, ui))
            .toMatchObject({ ok: true, result: { status: 'unavailable', code: 'dictation_field_unmounted' } });
        expect(home.requests.some(request => request.path.includes('/pending') || request.path.includes('/messages'))).toBe(false);
    });
});

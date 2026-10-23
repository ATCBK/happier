import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadOptions, DownloadProgressData, DownloadResumable } from 'expo-file-system/legacy';
import { createMemNativeDownload } from '@/voice/modelPacks/installerTestFs';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';

import { invokeVoiceDeviceModelPackOperation } from './voiceDeviceModelPackOperation.native';
import * as React from 'react';
import { createDeferred, renderHook, renderScreen, waitForTestEvent } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { useLocalNeuralModelPackState } from './panels/localTts/useLocalNeuralModelPackState.native';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import * as backgroundTasks from '@/utils/system/fireAndForget';

vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();

const filesystem = await vi.hoisted(async () => (await import('@/voice/modelPacks/installerTestFs')).createMemFs());
const nativeDialogs = vi.hoisted(() => ({
    alert: vi.fn<typeof import('react-native')['Alert']['alert']>(),
}));
const nativeDownload = vi.hoisted(() => vi.fn<(
    url: string, uri: string, options?: DownloadOptions, progress?: (value: DownloadProgressData) => void,
) => Pick<DownloadResumable, 'downloadAsync' | 'pauseAsync' | 'cancelAsync'>>());
const nativeTransferReplies: string[] = [];

// Only the native filesystem, OS dialog buttons and HTTP are substituted.
vi.mock('expo-file-system', () => filesystem.fs);
vi.mock('expo-file-system/legacy', () => ({ createDownloadResumable: nativeDownload,
    FileSystemSessionType: { BACKGROUND: 0, FOREGROUND: 1 } }));
vi.mock('@happier-dev/sherpa-native', () => ({ getOptionalHappierSherpaNativeModule: () => null }));
// Node selects portable sentinels; exercise the complete native platform leaf.
vi.mock('@/voice/settings/voiceDeviceModelPackOperation', () => import('@/voice/settings/voiceDeviceModelPackOperation.native'));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock(
    { platformOS: 'ios' }, { Alert: nativeDialogs }));
// Model operations never start the unavailable vendor conversation SDK.
vi.mock('@elevenlabs/client/web', () => ({ Conversation: { startSession: () => { throw new Error('Unexpected ElevenLabs conversation start'); } } }));
const { getPreferredLanguage, setPreferredLanguageFromSettings, t } = await import('@/text');
const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
const { createVoiceSettingsAccountTestHarness } = await import('./panels/voiceSettingsAccountTestHarness');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const initialLanguage = getPreferredLanguage();
afterAll(() => { setPreferredLanguageFromSettings(initialLanguage); });

const packId = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';
const modelUri = () => `${filesystem.root}/${packId}/model.onnx`;
const manifest = {
    packId, kind: 'stt_sherpa', model: 'zipformer', version: 'v2', buildId: 'build-2',
    files: [{ path: 'model.onnx', url: 'https://example.test/model.onnx', sizeBytes: 1,
        sha256: '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a' }],
};
const input = { packId, role: 'stt_sherpa' as const, isCurrent: () => true };
let modelAccount: Awaited<ReturnType<typeof createVoiceSettingsAccountTestHarness>> | null = null;
async function ensureModelAccount() {
    if (!modelAccount) modelAccount = await createVoiceSettingsAccountTestHarness(settingsParse({
        actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.invoke': ['ui'] } },
        voice: { providerId: 'local_conversation', providers: { local_conversation: { schemaVersion: 1, config: {
            stt: { provider: 'local_neural', localNeural: { assetId: packId, execution: 'device' } },
        } } } },
    }));
    return modelAccount;
}
async function mountModelState(props: Parameters<typeof useLocalNeuralModelPackState>[0]) {
    await ensureModelAccount();
    return renderHook(useLocalNeuralModelPackState, { initialProps: props });
}

function startRemoval(invoke: () => void) {
    // Retain the UI's real operation and original fire-and-forget error handling.
    const dispatched = vi.spyOn(backgroundTasks, 'fireAndForget');
    try {
        invoke();
        const operation = dispatched.mock.calls.find(([, options]) =>
            options?.tag === 'useLocalNeuralModelPackState.clearAssets')?.[0];
        if (!operation) throw new Error('Expected the native removal operation');
        return operation;
    } finally { dispatched.mockRestore(); }
}

describe('native device model operations through the real installer', () => {
    beforeEach(() => {
        filesystem.files.clear();
        nativeTransferReplies.length = 0;
        setPreferredLanguageFromSettings('en');
        nativeDialogs.alert.mockReset().mockImplementation((_title, _message, buttons) => {
            buttons?.find(button => button.style !== 'cancel')?.onPress?.();
        });
        vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('model.onnx')
            ? new Response(new Uint8Array([1]), { headers: { 'content-length': '1' } })
            : new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/json' } })));
        nativeDownload.mockReset().mockImplementation((url, uri, options, progress) => {
            const controller = new AbortController();
            return {
                async downloadAsync() {
                    const download = createMemNativeDownload(filesystem.fs, globalThis.fetch);
                    const result = await download({ url, fileUri: uri, signal: controller.signal,
                        onProgress: loaded => progress?.({ totalBytesWritten: loaded, totalBytesExpectedToWrite: loaded }),
                    });
                    nativeTransferReplies.push(url);
                    return { ...result, uri, mimeType: 'application/octet-stream' };
                },
                async pauseAsync() { return { url, fileUri: uri, options: options ?? {} }; },
                async cancelAsync() { controller.abort(); },
            };
        });
    });
    afterEach(async () => { vi.unstubAllGlobals(); await modelAccount?.dispose(); modelAccount = null; });

    it('explains the required and available storage before starting a native download', async () => {
        filesystem.fs.Paths.availableDiskSpace = 0;
        try {
            const hook = await mountModelState({
                ...input,
            });
            await act(async () => { await hook.getCurrent().prepareModel(); });
            expect(hook.getCurrent().modelStatus).toBe('error');
            const reason = t('settingsVoice.local.modelPackDownload.insufficientStorage', {
                required: formatHappierDataBytes(1, { kind: 'storage' }), available: formatHappierDataBytes(0, { kind: 'storage' }),
            });
            expect(nativeDialogs.alert.mock.calls.some(call => String(call[1]).includes(reason))).toBe(true);
            expect(filesystem.files.has(modelUri())).toBe(false);
            expect(nativeTransferReplies).toEqual([]);
        } finally { delete filesystem.fs.Paths.availableDiskSpace; }
    });

    it('keeps an admitted download running when settings closes and follows it on return', async () => {
        const artifactStarted = createDeferred<AbortSignal>();
        const response = createDeferred<Response>();
        vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
            if (String(url).includes('manifest')) return Response.json(manifest);
            if (!options.signal) throw new Error('Expected native transfer signal');
            artifactStarted.resolve(options.signal);
            return response.promise;
        }));
        const props = { ...input };
        const starter = await mountModelState(props);
        let operation!: Promise<void>;
        await act(async () => { operation = starter.getCurrent().prepareModel(); });
        const signal = await artifactStarted.promise;
        let follower: Awaited<ReturnType<typeof mountModelState>> | undefined;
        try {
            await starter.unmount();
            expect(signal.aborted).toBe(false);
            follower = await mountModelState(props);
            await waitForTestEvent(follower.subscribe, follower.getCurrent,
                state => state.modelStatus === 'downloading');
            expect(follower.getCurrent().modelStatus).toBe('downloading');
        } finally {
            response.resolve(new Response(new Uint8Array([1])));
            await act(async () => { await operation; });
        }
        await waitForTestEvent(follower!.subscribe, follower!.getCurrent,
            state => state.modelStatus === 'ready');
        expect(follower?.getCurrent().modelStatus).toBe('ready');
        expect(filesystem.files.has(modelUri())).toBe(true);
        expect(nativeDialogs.alert).not.toHaveBeenCalled();
    });

    it('ignores a previous pack outcome after a follower commits another selection', async () => {
        const artifactStarted = createDeferred<AbortSignal>();
        const response = createDeferred<Response>();
        vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
            if (String(url).includes('manifest')) return Response.json(manifest);
            if (!options.signal) throw new Error('Expected native transfer signal');
            artifactStarted.resolve(options.signal);
            return response.promise;
        }));
        const props = { ...input };
        const starter = await mountModelState(props);
        let operation!: Promise<void>;
        await act(async () => { operation = starter.getCurrent().prepareModel(); });
        const signal = await artifactStarted.promise;
        await starter.unmount();
        const follower = await mountModelState(props);
        try {
            await waitForTestEvent(follower.subscribe, follower.getCurrent,
                state => state.modelStatus === 'downloading');
            expect(follower.getCurrent().modelStatus).toBe('downloading');
            await follower.rerender({ ...props, packId: 'other-pack' });
            expect(signal.aborted).toBe(true);
        } finally {
            response.resolve(new Response(new Uint8Array([1])));
            await act(async () => { await operation; });
        }
        expect(follower.getCurrent().modelStatus).toBe('idle');
        expect(follower.getCurrent().downloadProgress).toBeNull();
        expect(follower.getCurrent().installed).toBe(false);
        expect(nativeDialogs.alert).not.toHaveBeenCalled();
    });

    it('cancels mounted native preparation through settings.invoke without removing model files', async () => {
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.invoke': ['ui'] } }, voice: { providerId: 'local_conversation',
            providers: { local_conversation: { schemaVersion: 1, config: { stt: { provider: 'local_neural',
                localNeural: { assetId: packId, execution: 'device' } } } } } } }));
        const entered = createDeferred<AbortSignal>();
        vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
            if (!options.signal) throw new Error('Native preparation must retain its caller signal');
            entered.resolve(options.signal);
            options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })));
        let owner: ReturnType<typeof useLocalNeuralModelPackState> | null = null;
        function Harness() {
            owner = useLocalNeuralModelPackState(input);
            return null;
        }
        const current = () => { if (!owner) throw new Error('Native preparation owner missing'); return owner; };
        const screen = await renderMountedCurrentUiContext(React.createElement(Harness));
        let operation: Promise<void> | undefined;
        try {
            await act(async () => { operation = current().prepareModel(); });
            const signal = await entered.promise;
            const result = await createDefaultActionExecutor().execute('settings.invoke', {
                anchor: 'voiceConversations.sttCancelPrepare', input: { kind: 'model_pack', packId },
            }, { surface: 'agent', serverId: account.scope.serverId });
            expect(result).toMatchObject({ ok: true, result: { status: 'completed' } });
            await act(async () => { await operation; });
            expect(signal.aborted).toBe(true);
            expect(current().modelStatus).toBe('idle');
            expect(filesystem.files.has(modelUri())).toBe(false);
            expect(nativeTransferReplies).toEqual([]);
        } finally {
            await act(async () => { current().cancelPrepare(); await operation; });
            await screen.unmount();
            await account.dispose();
        }
    });

    it.each(['prepare', 'update'] as const)('keeps a slow %s pending for its caller instead of imposing a local deadline', async (operation) => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            if (operation === 'update') {
                filesystem.files.set(modelUri(), new Uint8Array([9]));
                filesystem.files.set(`${filesystem.root}/${packId}/pack.json`, new TextEncoder().encode(JSON.stringify({
                    manifest: { ...manifest, version: 'v1', files: [{ ...manifest.files[0], sha256: 'a'.repeat(64) }] },
                })));
            }
            let finishManifest: ((response: Response) => void) | undefined;
            const manifestRequested = createDeferred<void>();
            let delayed = false;
            const fetchImpl: typeof fetch = async (url) => {
                if (String(url).endsWith('model.onnx')) {
                    return new Response(new Uint8Array([1]), { headers: { 'content-length': '1' } });
                }
                if (!delayed) {
                    delayed = true;
                    return await new Promise<Response>((resolve) => {
                        finishManifest = resolve;
                        manifestRequested.resolve();
                    });
                }
                return Response.json(manifest);
            };
            vi.stubGlobal('fetch', fetchImpl);
            const result = invokeVoiceDeviceModelPackOperation({ ...input, operation,
                manifestUrl: 'https://example.test/manifest.json' });
            const outcome = result.then((value) => value.status,
                (error: unknown) => error instanceof Error ? error.message : String(error));
            // Cold filesystem admission precedes the HTTP boundary. Only
            // advance time once there is a manifest request to keep pending.
            await manifestRequested.promise;
            await vi.advanceTimersByTimeAsync(300_000);
            // Only the held manifest's elapsed-time contract uses a fake clock;
            // real filesystem/SDK completion must run on the real scheduler.
            vi.useRealTimers();
            finishManifest?.(Response.json(manifest));
            expect(await outcome).toBe('completed');
            expect(nativeDownload, 'Native transfer admitted after manifest release').toHaveBeenCalled();
            expect(nativeTransferReplies, 'Native SDK transfer settled').toContain(manifest.files[0]!.url);
            expect(filesystem.files.get(modelUri())).toEqual(new Uint8Array([1]));
        } finally {
            vi.useRealTimers();
        }
    });

    it('reports download admission and real progress before publishing the installed pack', async () => {
        const events: string[] = [];
        const progress: unknown[] = [];
        const result = await invokeVoiceDeviceModelPackOperation({ ...input, operation: 'prepare',
            onDownloadStarted: () => events.push(filesystem.files.has(modelUri()) ? 'already-installed' : 'downloading'),
            onProgress: (value: unknown) => progress.push(value),
        });
        expect(result.status).toBe('completed');
        expect(events).toEqual(['downloading']);
        expect(progress).toContainEqual(expect.objectContaining({ loaded: 1, total: 1 }));
        expect(filesystem.files.get(modelUri())).toEqual(new Uint8Array([1]));
    });

    it('presents native progress through the admitted Settings Action and settles the installed state', async () => {
        const started = createDeferred<void>();
        const response = createDeferred<Response>();
        const transfer = nativeDownload.getMockImplementation()!;
        nativeDownload.mockImplementation((url, uri, options, progress) => {
            progress?.({ totalBytesWritten: 1, totalBytesExpectedToWrite: 1 });
            return transfer(url, uri, options, progress);
        });
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            if (String(url).includes('manifest')) return Response.json(manifest);
            started.resolve();
            return response.promise;
        }));
        const hook = await mountModelState(input);
        let operation!: Promise<void>;
        await act(async () => { operation = hook.getCurrent().prepareModel(); });
        try {
            await act(async () => { await started.promise; });
            expect(hook.getCurrent().downloadProgress).toMatchObject({ loaded: 1, total: 1 });
            expect(hook.getCurrent().modelStatus).toBe('downloading');
        } finally {
            response.resolve(new Response(new Uint8Array([1])));
            await act(async () => { await operation; });
        }
        expect(hook.getCurrent().modelStatus).toBe('ready');
        expect(hook.getCurrent().downloadProgress).toBeNull();
        expect(filesystem.files.get(modelUri())).toEqual(new Uint8Array([1]));
    });

    it('preserves the installed bytes when selection changes while removal consent is open', async () => {
        filesystem.files.set(modelUri(), new Uint8Array([9]));
        let current = true;
        nativeDialogs.alert.mockImplementationOnce((_title, _message, buttons) => {
            current = false;
            buttons?.find(button => button.style !== 'cancel')?.onPress?.();
        });
        expect(await invokeVoiceDeviceModelPackOperation({ ...input, operation: 'remove', isCurrent: () => current }))
            .toEqual({ status: 'cancelled' });
        expect(filesystem.files.get(modelUri())).toEqual(new Uint8Array([9]));
    });

    it('publishes checked update facts but does not replace files when consent is declined', async () => {
        filesystem.files.set(modelUri(), new Uint8Array([9]));
        filesystem.files.set(`${filesystem.root}/${packId}/pack.json`, new TextEncoder().encode(JSON.stringify({
            manifest: { ...manifest, version: 'v1', files: [{ ...manifest.files[0], sha256: 'a'.repeat(64) }] },
        })));
        nativeDialogs.alert.mockImplementationOnce((_title, _message, buttons) => {
            buttons?.find(button => button.style === 'cancel')?.onPress?.();
        });
        const checked: unknown[] = [];
        const result = await invokeVoiceDeviceModelPackOperation({ ...input, operation: 'update',
            onUpdateChecked: (value: unknown) => checked.push(value),
        });
        expect(result.status).toBe('cancelled');
        expect(checked).toEqual([expect.objectContaining({ updateAvailable: true, build: expect.any(String) })]);
        expect(filesystem.files.get(modelUri())).toEqual(new Uint8Array([9]));
    });

    it('does not remove the old UI selection after the pack changes during consent', async () => {
        filesystem.files.set(modelUri(), new Uint8Array([9]));
        const consent = createDeferred<void>();
        let answer!: (confirmed: boolean) => void;
        nativeDialogs.alert.mockImplementationOnce((_title, _message, buttons) => {
            answer = confirmed => buttons?.find(button => (button.style === 'cancel') === !confirmed)?.onPress?.();
            consent.resolve();
        });
        const props = { packId,
            role: 'stt_sherpa' as const };
        const hook = await mountModelState(props);
        let removal!: Promise<unknown>;
        await act(async () => { removal = startRemoval(() => hook.getCurrent().clearAssets()); });
        await consent.promise;
        expect(answer).toEqual(expect.any(Function));
        await hook.rerender({ ...props, packId: 'other-pack' });
        await act(async () => { answer(true); await removal; });
        expect(filesystem.files.get(modelUri())).toEqual(new Uint8Array([9]));
        expect(hook.getCurrent().modelStatus).toBe('idle');
    });

    it('cancels UI preparation through the installer and settles back to idle', async () => {
        const entered = createDeferred<void>();
        vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
            entered.resolve();
            options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })));
        const hook = await mountModelState({
            ...input,
        });
        let operation!: Promise<void>;
        await act(async () => { operation = hook.getCurrent().prepareModel(); });
        await act(async () => { await entered.promise; });
        expect(hook.getCurrent().modelStatus).toBe('downloading');
        await act(async () => { hook.getCurrent().cancelPrepare(); await operation; });
        expect(hook.getCurrent().modelStatus).toBe('idle');
        expect(hook.getCurrent().downloadProgress).toBeNull();
        expect(filesystem.files.has(modelUri())).toBe(false);
    });

    it('aborts admitted UI work when device execution is deselected', async () => {
        const entered = createDeferred<void>();
        let fetchSignal: AbortSignal | null = null;
        vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
            fetchSignal = options.signal ?? null;
            fetchSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            entered.resolve();
        })));
        const props = { ...input, enabled: true };
        const hook = await mountModelState(props);
        let operation!: Promise<void>;
        await act(async () => { operation = hook.getCurrent().prepareModel(); });
        await act(async () => { await entered.promise; });
        expect(fetchSignal).not.toBeNull();
        expect(hook.getCurrent().modelStatus).toBe('downloading');
        await hook.rerender({ ...props, enabled: false });
        await act(async () => { await operation; });
        expect((fetchSignal as AbortSignal | null)?.aborted).toBe(true);
        expect(hook.getCurrent().modelStatus).toBe('idle');
        expect(filesystem.files.has(modelUri())).toBe(false);
    });

    it('keeps committed removal custody when a replacement selection suspends without committing', async () => {
        await ensureModelAccount();
        filesystem.files.set(modelUri(), new Uint8Array([9]));
        const consent = createDeferred<void>();
        let answer!: (confirmed: boolean) => void;
        nativeDialogs.alert.mockImplementationOnce((_title, _message, buttons) => {
            answer = confirmed => buttons?.find(button => (button.style === 'cancel') === !confirmed)?.onPress?.();
            consent.resolve();
        });
        const neverCommits = new Promise<never>(() => undefined);
        function Harness(props: { packId: string; suspend?: Promise<never> }) {
            const owner = useLocalNeuralModelPackState({ ...input, packId: props.packId });
            if (props.suspend) throw props.suspend;
            return React.createElement('Remove', { onPress: owner.clearAssets });
        }
        const screen = await renderScreen(React.createElement(React.Suspense, { fallback: React.createElement('Fallback') },
            React.createElement(Harness, { packId })));
        const { tree } = screen;
        let removal!: Promise<unknown>;
        await act(async () => { removal = startRemoval(() => tree.root.findByType('Remove').props.onPress()); });
        await consent.promise;
        expect(answer).toEqual(expect.any(Function));
        let replacement!: Promise<void>;
        React.startTransition(() => {
            replacement = screen.update(React.createElement(React.Suspense, { fallback: React.createElement('Fallback') },
                React.createElement(Harness, { packId: 'other-pack', suspend: neverCommits })));
        });
        await replacement;
        expect(tree.root.findAllByType('Fallback')).toHaveLength(0);
        await act(async () => { answer(true); await removal; });
        expect(filesystem.files.has(modelUri())).toBe(false);
    });

    it('preserves device files when Account retirement invalidates pending removal consent for the same pack', async () => {
        const previous = await ensureModelAccount();
        const lifetime = captureActiveServerAccountScopeLifetime();
        expect(lifetime?.isCurrent()).toBe(true);
        filesystem.files.set(modelUri(), new Uint8Array([9]));
        const consent = createDeferred<void>();
        let answer!: (confirmed: boolean) => void;
        nativeDialogs.alert.mockImplementationOnce((_title, _message, buttons) => {
            answer = confirmed => buttons?.find(button => (button.style === 'cancel') === !confirmed)?.onPress?.();
            consent.resolve();
        });
        const hook = await renderHook(useLocalNeuralModelPackState, { initialProps: input });
        let removal!: Promise<unknown>;
        await act(async () => { removal = startRemoval(() => hook.getCurrent().clearAssets()); });
        await consent.promise;
        expect(answer).toEqual(expect.any(Function));
        await act(async () => { retireActiveServerAccountScopeLifetime(); });
        expect(lifetime?.isCurrent()).toBe(false);
        expect(filesystem.files.get(modelUri())).toEqual(new Uint8Array([9]));
        // The replacement Account is restored through the same real Settings owner.
        await previous.dispose();
        modelAccount = null;
        await ensureModelAccount();
        // A retired consent prompt must not keep the new Account's UI busy.
        await act(async () => { await startRemoval(() => hook.getCurrent().clearAssets()); });
        expect(filesystem.files.has(modelUri())).toBe(false);
        // New Account work can install bytes while the old dialog is still open.
        filesystem.files.set(modelUri(), new Uint8Array([7]));
        await act(async () => { answer(true); await removal; });
        expect(filesystem.files.get(modelUri())).toEqual(new Uint8Array([7]));
        await hook.unmount();
    });
});

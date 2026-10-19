import * as React from 'react';
import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { getDefaultModelPackId, listModelPackCatalogEntries } from '@happier-dev/protocol/voice/modelPacks/catalog';
import { createRpcCallError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import {
    DaemonVoiceInferenceModelStatusSchema, DaemonVoiceInferenceModelsListResponseSchema,
    DaemonVoiceInferenceModelsStatusResponseSchema, DaemonVoiceInferenceModelsInstallResponseSchema,
    DaemonVoiceInferenceModelsRemoveResponseSchema, DaemonVoiceInferenceModelLicenseAcceptResponseSchema,
    DaemonVoiceInferenceModelLicenseAcceptRequestSchema, type DaemonVoiceInferenceModelStatus,
} from '@happier-dev/protocol/daemon/voiceInference';
import { pressTestInstanceAsync, renderScreen, createDeferred } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
const nativeAlert = vi.hoisted(() => vi.fn<(typeof import('react-native'))['Alert']['alert']>());
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock(
    { platformOS: 'ios' }, { Alert: { alert: nativeAlert } },
));
const account = createProviderSettingsAccountHarness();
let respond: Parameters<typeof installSessionActionRpcBoundary>[0];
const requests = installSessionActionRpcBoundary((request, context) => respond(request, context));
const { DaemonVoiceModelCatalogSection } = await import('./DaemonVoiceModelCatalogSection');
const { useDaemonVoiceModelCatalogState } = await import('./useDaemonVoiceModelCatalogState');
const MACHINE = 'catalog-section-machine';

function chooseNativeConfirmation(accepted: boolean) {
    const buttons = nativeAlert.mock.calls.at(-1)?.[2];
    const button = buttons?.find(candidate => accepted ? candidate.style !== 'cancel' : candidate.style === 'cancel');
    if (!button?.onPress) throw new Error('Expected an actual native confirmation button');
    button.onPress();
}

function status(packId: string, overrides: Partial<DaemonVoiceInferenceModelStatus> = {}) {
    const entry = listModelPackCatalogEntries().find(candidate => candidate.packId === packId);
    return DaemonVoiceInferenceModelStatusSchema.parse({
        packId, pluginIdentity: null, kind: entry?.kind ?? 'stt_sherpa', model: entry?.model ?? packId,
        version: null, executionSupport: ['daemon'], runtimeFamily: entry?.runtimeFamily ?? null,
        runtimeSupported: true, installState: 'installed', progress: null, lastError: null,
        updatedAtMs: 0, runtimeState: 'cold', ...overrides,
    });
}

function catalogReply(models: readonly DaemonVoiceInferenceModelStatus[]) {
    respond = request => {
        if (request.method.endsWith(':daemon.voiceInference.models.list')) return DaemonVoiceInferenceModelsListResponseSchema.parse({ ok: true, models });
        if (request.method.endsWith(':daemon.voiceInference.models.status')) return DaemonVoiceInferenceModelsStatusResponseSchema.parse({ ok: true, models: [] });
        if (request.method.endsWith(':daemon.voiceInference.models.remove')) return DaemonVoiceInferenceModelsRemoveResponseSchema.parse({ ok: true });
        throw new Error(`Unexpected model RPC: ${request.method}`);
    };
}

function renderSection(props: Partial<React.ComponentProps<typeof DaemonVoiceModelCatalogSection>> = {}) {
    return renderScreen(<DaemonVoiceModelCatalogSection selectedSttPackId={null} selectedTtsPackId={null}
        onSelectDefault={() => undefined} {...props} />).then(result => result.tree);
}

function modelRows(tree: ReactTestRenderer) {
    return tree.root.findAll(node => typeof node.props.testID === 'string'
        && node.props.testID.startsWith('voice-model-row-') && typeof node.type !== 'string');
}

describe('DaemonVoiceModelCatalogSection', () => {
    beforeEach(async () => {
        nativeAlert.mockReset();
        requests.length = 0;
        catalogReply([]);
        const scope = await account.restore({
            settings: { experiments: true, featureToggles: { 'voice.agent': true, 'execution.runs': true, 'voice.daemonInference': true },
                voice: { executionMachine: { mode: 'fixed', machineId: MACHINE } } },
            machines: [createMachineFixture({ id: MACHINE, activeAt: Date.now() })],
            features: createRootLayoutFeaturesResponse({ features: {
                voice: { enabled: true },
                machines: { enabled: true, liveStream: { ...createRootLayoutFeaturesResponse().features.machines.liveStream, enabled: true, serverRouted: { enabled: true } } },
            }, capabilities: { machines: { ...createRootLayoutFeaturesResponse().capabilities.machines, liveStream: { serverRouted: { disabledReason: null, caps: {
                maxBitrateBps: 64_000, maxFramesPerSecond: 50, maxFrameBytes: 16_000, maxDurationMs: 60_000,
                maxTotalBytes: 1_000_000, maxConcurrentStreamsPerAccount: 2, maxConcurrentStreamsPerSocket: 1,
                maxConcurrentStreamsPerMachine: 1,
            } } } } } }),
        });
        const machine = createPlainMachineRowFixture({ id: MACHINE, accountId: scope.accountId });
        account.home.answer(scope.serverId, `/v1/machines/${MACHINE}`, { body: { machine } });
        account.home.answer(scope.serverId, `/v1/machines/${MACHINE}/access`, { body: { machineId: MACHINE,
            custodian: machine.access!.custodian, access: machine.access, canManage: true,
            grants: [], ownDirectGrant: false, ownAccessSources: [] } });
    });
    afterEach(async () => { await account.reset(); vi.restoreAllMocks(); });

    it('shows a loading status row before the daemon status resolves', async () => {
        const pending = createDeferred<unknown>();
        respond = request => request.method.endsWith(':daemon.voiceInference.models.list')
            ? pending.promise : DaemonVoiceInferenceModelsStatusResponseSchema.parse({ ok: true, models: [] });
        const tree = await renderSection();
        expect(tree.root.findByProps({ testID: 'voice-model-catalog-status' }).props.kind).toBe('loading');
        expect(modelRows(tree)).toHaveLength(0);
        await act(async () => pending.resolve(DaemonVoiceInferenceModelsListResponseSchema.parse({ ok: true, models: [] })));
        await vi.waitFor(() => expect(tree.root.findAllByProps({ testID: 'voice-model-catalog-status' })).toHaveLength(0));
    });

    it('leaves loading and renders unavailable when the selected daemon does not serve speech RPCs', async () => {
        respond = () => { throw createRpcCallError({ error: 'RPC method not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }); };
        const tree = await renderSection();
        await vi.waitFor(() => expect(tree.root.findByProps({ testID: 'voice-model-catalog-status' }).props.kind).toBe('unavailable'));
        expect(modelRows(tree)).toHaveLength(0);

        catalogReply([]);
        // Reopening after an owner-managed daemon reload uses the normal status path.
        const recovered = await renderSection();
        await vi.waitFor(() => expect(recovered.root.findAllByProps({ testID: 'voice-model-catalog-status' })).toHaveLength(0));
        expect(modelRows(recovered).length).toBeGreaterThan(0);
    });

    it.each([
        ['machine_unreachable', 'Can’t reach your Voice machine right now.', true],
        ['feature_disabled', 'Speech models are turned off on this server.', false],
        ['runtime_unavailable', 'Your Voice machine can’t run speech models.', false],
        ['request_timeout', 'Your Voice machine didn’t answer in time.', true],
        ['internal_error', 'Speech models couldn’t be loaded.', true],
    ] as const)('says once why the catalog is unavailable (%s) instead of an unknown state on every model', async (code, message, retryable) => {
        if (code === 'feature_disabled') {
            await account.publishFeatures(account.serverId, createRootLayoutFeaturesResponse({ features: { voice: { enabled: false } } }));
        } else {
            respond = request => request.method.endsWith(':daemon.voiceInference.models.list')
                ? DaemonVoiceInferenceModelsListResponseSchema.parse({ ok: false, error: 'daemon model request failed', errorCode: code })
                : DaemonVoiceInferenceModelsStatusResponseSchema.parse({ ok: true, models: [] });
        }
        const tree = await renderSection();
        await vi.waitFor(() => expect(tree.root.findByProps({ testID: 'voice-model-catalog-status' }).props.kind).not.toBe('loading'));
        const line = tree.root.findByProps({ testID: 'voice-model-catalog-status' });
        expect(line.props.title).toBe(message);
        expect(modelRows(tree)).toHaveLength(0);
        expect(requests.some(request => request.method.endsWith('.install'))).toBe(false);
        if (!retryable) { expect(line.props.action).toBeUndefined(); return; }
        const before = requests.filter(request => request.method.endsWith('.list')).length;
        await act(async () => line.props.action.onPress());
        await vi.waitFor(() => expect(requests.filter(request => request.method.endsWith('.list')).length).toBeGreaterThan(before));
    });

    it('can render from an already-created catalog controller without opening a second status request', async () => {
        const packId = getDefaultModelPackId('stt_sherpa')!;
        catalogReply([status(packId, { runtimeState: 'ready' })]);
        function SharedOwner() {
            const controller = useDaemonVoiceModelCatalogState();
            return <DaemonVoiceModelCatalogSection selectedSttPackId={packId} selectedTtsPackId={null}
                onSelectDefault={() => undefined} catalogController={controller} />;
        }
        const { tree } = await renderScreen(<SharedOwner />);
        await vi.waitFor(() => expect(tree.root.findByProps({ testID: `voice-model-row-${packId}` }).props.detail).toBe('Ready'));
        expect(requests.filter(request => request.method.endsWith('.list'))).toHaveLength(1);
        expect(requests.filter(request => request.method.endsWith('.status'))).toHaveLength(1);
    });

    it('keeps an installed but unavailable non-default pack non-selectable and removable', async () => {
        const ttsDefault = getDefaultModelPackId('tts_sherpa')!;
        const unavailable = listModelPackCatalogEntries('tts_sherpa').find(entry => entry.packId !== ttsDefault && entry.publicationStatus === 'unavailable')!;
        catalogReply([status(ttsDefault), status(unavailable.packId)]);
        const onSelectDefault = vi.fn();
        const tree = await renderSection({ selectedTtsPackId: ttsDefault, onSelectDefault });
        await vi.waitFor(() => expect(tree.root.findByProps({ testID: `voice-model-row-${unavailable.packId}` })).toBeTruthy());
        const row = tree.root.findByProps({ testID: `voice-model-row-${unavailable.packId}` });
        expect(row.props.onPress ?? row.props.onClick).toBeUndefined();
        expect(onSelectDefault).not.toHaveBeenCalled();
        expect(tree.root.findByProps({ testID: `voice-model-remove-${unavailable.packId}` })).toBeTruthy();
        expect(requests.some(request => request.method.endsWith('.remove'))).toBe(false);
    });

    it('keeps a selected installed unsupported pack inert but removable for recovery', async () => {
        const entry = listModelPackCatalogEntries('stt_sherpa').find(entry => entry.runtimeFamily === 'sherpa_parakeet_offline')!;
        catalogReply([status(entry.packId, { runtimeSupported: false })]);
        const tree = await renderSection({ selectedSttPackId: entry.packId });
        await vi.waitFor(() => expect(tree.root.findByProps({ testID: `voice-model-row-${entry.packId}` })).toBeTruthy());
        expect(tree.root.findByProps({ testID: `voice-model-row-${entry.packId}` }).props.onPress).toBeUndefined();
        expect(tree.root.findByProps({ testID: `voice-model-remove-${entry.packId}` })).toBeTruthy();
    });

    it('reviews and accepts the exact external-pack license binding before installing', async () => {
        const packId = 'acme.speech/english-small';
        const review = {
            pluginId: 'acme.speech', packId: 'english-small', pluginVersion: '1.2.3', packVersion: '2026.7.0',
            licenseId: 'acme-model-license-v1', licenseTitle: 'Acme model license', licenseText: 'Review these exact model terms.',
            licenseSourceUrl: 'https://example.com/licenses/acme-v1', licenseTextDigest: `sha256:${'a'.repeat(64)}`,
            artifactBinding: { kind: 'sourceIntegrity', integrity: `sha256:${'b'.repeat(64)}` }, accepted: false,
        } as const;
        const model = status(packId, { pluginIdentity: { pluginId: review.pluginId, packId: review.packId },
            model: 'acme-english-small', version: review.packVersion, runtimeFamily: 'sherpa_zipformer_streaming',
            installState: 'not_installed', licenseReview: review });
        catalogReply([model]);
        const defaultReply = respond;
        respond = (request, context) => {
            if (request.method.endsWith('.license.accept')) return DaemonVoiceInferenceModelLicenseAcceptResponseSchema.parse({ ok: true, model });
            if (request.method.endsWith('.install')) return DaemonVoiceInferenceModelsInstallResponseSchema.parse({ ok: true, model: { ...model, installState: 'installed' } });
            return defaultReply(request, context);
        };
        const tree = await renderSection();
        await vi.waitFor(() => expect(tree.root.findByProps({ testID: `voice-model-row-${packId}` }).props.onPress).toBeTypeOf('function'));
        await pressTestInstanceAsync(tree.root.findByProps({ testID: `voice-model-row-${packId}` }));
        expect(nativeAlert).toHaveBeenCalledOnce();
        expect(nativeAlert).toHaveBeenCalledWith(review.licenseTitle, review.licenseText,
            expect.arrayContaining([expect.objectContaining({ style: 'cancel' }), expect.objectContaining({ style: 'default', text: expect.any(String) })]),
            { cancelable: false });
        await act(async () => chooseNativeConfirmation(true));
        await vi.waitFor(() => expect(requests.some(request => request.method.endsWith('.install'))).toBe(true));
        const accepted = requests.find(request => request.method.endsWith('.license.accept'))!;
        expect(DaemonVoiceInferenceModelLicenseAcceptRequestSchema.parse(accepted.params)).toEqual({
            qualifiedPackId: packId, pluginId: review.pluginId, packId: review.packId, pluginVersion: review.pluginVersion,
            packVersion: review.packVersion, licenseId: review.licenseId, licenseSourceUrl: review.licenseSourceUrl,
            licenseTextDigest: review.licenseTextDigest, artifactBinding: review.artifactBinding,
        });
        expect(requests.indexOf(accepted)).toBeLessThan(requests.findIndex(request => request.method.endsWith('.install')));
    });

    it.each([false, true])('removes the installed default pack only after its one confirmation is accepted: %s', async accepted => {
        const packId = getDefaultModelPackId('stt_sherpa')!;
        catalogReply([status(packId)]);
        const tree = await renderSection({ selectedSttPackId: packId });
        await vi.waitFor(() => expect(tree.root.findByProps({ testID: `voice-model-remove-${packId}` })).toBeTruthy());
        await pressTestInstanceAsync(tree.root.findByProps({ testID: `voice-model-remove-${packId}` }));
        expect(nativeAlert).toHaveBeenCalledOnce();
        expect(nativeAlert).toHaveBeenCalledWith(expect.any(String), expect.any(String),
            expect.arrayContaining([expect.objectContaining({ style: 'destructive' })]), { cancelable: false });
        await act(async () => chooseNativeConfirmation(accepted));
        if (accepted) await vi.waitFor(() => expect(requests.filter(request => request.method.endsWith('.remove'))).toHaveLength(1));
        expect(requests.filter(request => request.method.endsWith('.remove')).map(request => request.params)).toEqual(accepted ? [{ packId }] : []);
    });

    it('makes every competing model action inert while the catalog mutation owner is active', async () => {
        const sttPack = getDefaultModelPackId('stt_sherpa')!;
        const ttsPack = getDefaultModelPackId('tts_sherpa')!;
        catalogReply([status(sttPack), status(ttsPack)]);
        const tree = await renderSection();
        await vi.waitFor(() => expect(tree.root.findByProps({ testID: `voice-model-remove-${sttPack}` })).toBeTruthy());
        await act(async () => { void tree.root.findByProps({ testID: `voice-model-remove-${sttPack}` }).props.onPress(); });
        expect(nativeAlert).toHaveBeenCalledOnce();
        const row = tree.root.findByProps({ testID: `voice-model-row-${ttsPack}` });
        const remove = tree.root.findByProps({ testID: `voice-model-remove-${ttsPack}` });
        expect(row.props.onPress ?? row.props.onClick).toBeUndefined();
        expect(row.props.disabled).toBe(true);
        expect(remove.props.disabled).toBe(true);
        const control = remove.findAll(node => typeof node.type === 'string' && (node.props.accessibilityRole === 'button' || node.props.role === 'button'))[0];
        expect(control?.props.accessibilityState?.disabled ?? control?.props['aria-disabled']).toBe(true);
        await act(async () => chooseNativeConfirmation(false));
        expect(requests.some(request => request.method.endsWith('.remove'))).toBe(false);
    });
});

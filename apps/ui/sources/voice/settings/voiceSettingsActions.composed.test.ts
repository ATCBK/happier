import 'fake-indexeddb/auto';
import { afterAll, afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { SettingsDeclarationActionOutputSchemasV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { AccountSettingsStoredContentEnvelopeSchema } from '@happier-dev/protocol/account/settings/accountSettingsStoredContentEnvelope';
import { createDeferred, standardCleanup } from '@/dev/testkit';
import type { SpeechOptions } from 'expo-speech';
import { createVoiceSpeechOutputBoundary } from '@/dev/testkit/harness/voiceSpeechOutputBoundary';

// Install the canonical transport boundary before the real Sync/Action graph.
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

afterEach(() => standardCleanup());
const speech = createVoiceSpeechOutputBoundary({ getAccount: async () => { throw new Error('Device speech must not request daemon speech'); } });
afterAll(() => speech.disposeAudioSession());
// Load the real composition after transport installation, outside the timed
// behavior window; cold graph transformation is not a speech operation.
const { createVoiceSettingsAccountTestHarness } = await import('./panels/voiceSettingsAccountTestHarness');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');

describe('Voice declarations through the default Settings Action and Account persistence', () => {
    it('lists and retries the selected local-neural voice catalog for Agents without starting playback', async () => {
        const { filesystem } = speech.reset();
        const { parseModelPackManifest } = await import('@happier-dev/protocol/voice/modelPacks/manifest');
        const packId = 'settings-catalog-kokoro';
        const manifest = parseModelPackManifest({ packId, kind: 'tts_sherpa', model: 'kokoro', version: '1', frontend: { lang: 'en' },
            voices: [{ id: 'am_adam', title: 'Adam', sid: 0 }], defaultVoiceId: 'am_adam',
            files: [{ path: 'model.onnx', url: 'https://example.test/model.onnx', sha256: 'a'.repeat(64), sizeBytes: 1 }] });
        filesystem.files.set(`${filesystem.root}/${packId}/pack.json`, new TextEncoder().encode(JSON.stringify({ manifest })));
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: { providerId: 'local_conversation',
            providers: { local_conversation: { schemaVersion: 1, config: { tts: { provider: 'local_neural',
                localNeural: { execution: 'device', assetId: packId } } } } } } }));
        onTestFinished(account.dispose);
        const executor = createDefaultActionExecutor();
        for (const anchor of ['voiceConversations.ttsCatalog', 'voiceConversations.ttsCatalogRetry']) {
            const result = await executor.execute('settings.invoke', { anchor }, {
                surface: 'agent', authority: 'account_automation', serverId: account.scope.serverId, expectedAccountId: account.scope.accountId,
            });
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'completed', value: { rows: [{ id: 'am_adam', name: 'Adam' }] } } });
        }
        expect(speech.nativeSynthesize).not.toHaveBeenCalled();
        expect(speech.encodedAudio.start).not.toHaveBeenCalled();
        expect(account.writes).toHaveLength(0);
    });
    it('admits web catalog Stop through the existing local-neural Settings Action', async () => {
        const previousPlatform = speech.platform.value;
        speech.platform.value = 'web';
        onTestFinished(() => { speech.platform.value = previousPlatform; });
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: { providerId: 'local_conversation' } }));
        onTestFinished(account.dispose);
        const { localNeuralTtsPreviewController } = await import('./panels/localTts/providers/localNeural/previewLocalNeuralTts');
        const preview = localNeuralTtsPreviewController.begin('af_maple');
        onTestFinished(() => preview.finish());
        const result = await createDefaultActionExecutor().execute('settings.invoke', { anchor: 'voiceConversations.ttsPreviewStop' }, {
            surface: 'ui', authority: 'present_user', serverId: account.scope.serverId, expectedAccountId: account.scope.accountId,
        });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'completed', value: { stopped: true } } });
        expect(localNeuralTtsPreviewController.read()).toBeNull();
        expect(account.writes).toHaveLength(0);
    });
    it('cancels Device Test through settings.invoke and releases its playback lease', async () => {
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: { providerId: 'local_conversation',
            providers: { local_conversation: { schemaVersion: 1, config: { tts: { provider: 'device' } } } } } }));
        onTestFinished(account.dispose);
        const entered = createDeferred<SpeechOptions>();
        speech.expoSpeechSpeak.mockReset().mockImplementation((_text, options) => entered.resolve(options));
        speech.expoSpeechStop.mockReset();
        const controller = new AbortController();
        const pending = createDefaultActionExecutor().execute('settings.invoke', { anchor: 'voiceConversations.testTts' }, {
            surface: 'ui', authority: 'present_user', serverId: account.scope.serverId, expectedAccountId: account.scope.accountId,
            presentUserConfirmation: { actionId: 'settings.invoke' }, signal: controller.signal,
        });
        let playback: SpeechOptions | undefined;
        // Always release the held OS operation if the deciding assertion fails.
        try {
            playback = await Promise.race([entered.promise, pending.then(result => {
                throw new Error('Device sample settled before playback: ' + JSON.stringify(result));
            })]);
            expect(speech.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(1);
            controller.abort();
            expect(speech.expoSpeechStop).toHaveBeenCalledOnce();
            await pending;
            expect(speech.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
            expect(account.writes).toHaveLength(0);
        } finally {
            playback?.onDone?.();
            await pending;
        }
    });
    it('persists a nested Voice edit, preserves unrelated preferences, and refuses invalid writes', async () => {
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: {
            providerId: 'local_conversation', assistantLanguage: 'fr', privacy: { shareToolNames: false },
        } }));
        onTestFinished(account.dispose);
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, authority: 'present_user' as const,
            serverId: account.scope.serverId, expectedAccountId: account.scope.accountId };
        const execute = (anchor: string, value: unknown) => executor.execute('settings.set', { anchor, value }, context);
        const changed = await execute('voicePrivacy.recentMessagesCount', 7);
        expect(changed, JSON.stringify(changed)).toMatchObject({ ok: true,
            result: { anchor: 'voicePrivacy.recentMessagesCount', value: 7 } });
        if (!changed.ok) throw new Error('Settings Action failed');
        expect(SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(changed.result))
            .toMatchObject({ anchor: 'voicePrivacy.recentMessagesCount', value: 7 });
        expect(account.persistedSettings.voice).toMatchObject({ assistantLanguage: 'fr',
            privacy: { recentMessagesCount: 7, shareToolNames: false } });
        for (const write of account.writes) {
            if (!write || typeof write !== 'object' || !('content' in write)) throw new Error('Missing Settings envelope');
            expect(AccountSettingsStoredContentEnvelopeSchema.parse(write.content).t).toBe('plain');
        }
        expect(account.writes.length).toBeGreaterThan(0);
        const before = account.persistedSettings;
        const writeCount = account.writes.length;
        expect(await execute('voicePrivacy.recentMessagesCount', -1)).toMatchObject({ ok: false });
        // A missing declaration is the mis-wiring vector: it must neither
        // resolve an arbitrary JSON path nor mutate the persisted Account.
        expect(await execute('voicePrivacy.unregisteredField', 8)).toMatchObject({ ok: false });
        expect(account.writes).toHaveLength(writeCount);
        expect(account.persistedSettings).toEqual(before);
        expect(await executor.execute('settings.get', { anchor: 'voicePrivacy.recentMessagesCount' }, context))
            .toMatchObject({ ok: true, result: { anchor: 'voicePrivacy.recentMessagesCount', value: 7 } });
    });
});

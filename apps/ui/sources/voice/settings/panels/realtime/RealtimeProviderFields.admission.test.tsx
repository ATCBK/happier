import * as React from 'react';
import { Alert } from 'react-native';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

import { renderScreen as renderAppScreen } from '@/dev/testkit/render/renderScreen';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createDeferred, waitForTestEvent } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createVoiceSettingsAccountTestHarness } from '../voiceSettingsAccountTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { readVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { storage, useSetting } from '@/sync/domains/state/storage';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { Slider } from '@/components/ui/forms/Slider';
import { Switch } from '@/components/ui/forms/Switch';
import { ModalProvider } from '@/modal';
import { setPreferredLanguageFromSettings, tLoose } from '@/text';
import { VoiceGreetingItem } from '../VoiceGreetingItem';
import { resolveVoiceWelcomeSelection } from '@/voice/settings/welcome';
import { useVoiceSettingsMutable } from '@/voice/settings/useVoiceSettingsMutable';
import { useBundledConversationProviderSettings } from './useBundledConversationProviderSettings';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { RealtimeProviderFields } from './RealtimeProviderFields';

const platform = vi.hoisted(() => ({ value: 'ios' }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock(
    { platformOS: 'ios' }, { Platform: { get OS() { return platform.value; } } },
));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
installDisconnectedServerSocketBoundary();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const originalState = storage.getState();
const nativeAlert = vi.spyOn(Alert, 'alert');
let nextNativeAlert = createDeferred<Parameters<typeof Alert.alert>>();
afterAll(() => nativeAlert.mockRestore());
let modalHostActive = true;
function AdmissionProviders({ children }: React.PropsWithChildren) {
    return <ModalProvider active={modalHostActive}>{children}</ModalProvider>;
}
function renderScreen(element: Parameters<typeof renderAppScreen>[0]) {
    return renderAppScreen(element, { wrapper: AdmissionProviders });
}
beforeEach(() => {
    modalHostActive = true;
    platform.value = 'ios';
    nativeAlert.mockReset();
    nextNativeAlert = createDeferred<Parameters<typeof Alert.alert>>();
    nativeAlert.mockImplementation((...args) => { nextNativeAlert.resolve(args); });
    setPreferredLanguageFromSettings('en');
});
afterEach(() => { standardCleanup(); storage.setState(originalState, true); });

const provider = createDefaultVoiceProviderRegistry().list().find(entry => 'declaration' in entry && entry.declaration?.id === 'realtime-openai');
if (!provider?.providerSettings) throw new Error('OpenAI declared Voice settings missing');
const providerId = provider.providerId;
const descriptor = provider.providerSettings;
const elevenlabs = createDefaultVoiceProviderRegistry().list().find(entry => 'declaration' in entry && entry.declaration?.id === 'realtime-elevenlabs');
if (!elevenlabs?.providerSettings) throw new Error('ElevenLabs declared Voice settings missing');
const xai = createDefaultVoiceProviderRegistry().list().find(entry => 'declaration' in entry && entry.declaration?.id === 'realtime-grok');
if (!xai?.providerSettings) throw new Error('xAI declared Voice settings missing');

/** The existing settings consumer and writer remain real below the Home HTTP boundary. */
function VoiceFields({ paths = ['voice'] }: { paths?: readonly string[] }) {
    const [voice] = useVoiceSettingsMutable();
    const settings = useBundledConversationProviderSettings(voice);
    if (!settings.owner || !settings.config || !settings.descriptor) throw new Error('Voice settings unavailable');
    if (!voice.providerId) throw new Error('Voice provider missing');
    return <RealtimeProviderFields providerId={voice.providerId} owner={settings.owner} config={settings.config}
        descriptor={{ ...settings.descriptor, fields: settings.descriptor.fields.filter(field => paths.includes(field.path)) }}
        credentialStatus="ready" catalog={{ phase: 'ready', rows: [{ id: 'alloy', name: 'Alloy' }, { id: 'sage', name: 'Sage' }] }}
        welcomeSelection={resolveVoiceWelcomeSelection(voice.welcome)} assistantLanguage={voice.assistantLanguage}
        onRequestCatalog={() => {}} />;
}

/** Local voice presents the same shared Account Greeting control without a provider descriptor. */
function LocalGreeting() {
    const voice = useSetting('voice');
    return <VoiceGreetingItem value={resolveVoiceWelcomeSelection(voice.welcome)} />;
}

describe('declared Voice field Action admission', () => {
    it.each([
        { entry: provider, path: 'voice', config: { ...descriptor.defaultConfig, voice: 'alloy' }, expected: { voice: 'sage' } },
        { entry: elevenlabs, path: 'tts.voiceId', config: { ...elevenlabs.providerSettings!.defaultConfig, billingMode: 'byo' }, expected: { tts: { voiceId: 'sage' } } },
    ])('persists the declared $path selection against the current Account settings', async ({ entry, path, config, expected }) => {
        const id = entry.providerId;
        const settings = entry.providerSettings!;
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({
            voice: { providerId: id, providers: { [id]: { schemaVersion: settings.schemaVersion, config } } },
        }));
        try {
            const screen = await renderScreen(<VoiceFields paths={[path]} />);
            const picker = screen.findAllByType(DropdownMenu).find(node => node.props.testID === `voice-realtime-field-${path.replaceAll('.', '-')}`);
            if (!picker) throw new Error('Voice field missing');
            act(() => account.replaceVoice({ ...account.settings.voice, assistantLanguage: 'fr' }));
            await act(async () => picker.props.onSelect('sage'));
            expect(readVoiceProviderSettingsConfig(account.persistedSettings.voice, id)).toMatchObject(expected);
            expect(account.persistedSettings.voice.assistantLanguage).toBe('fr');
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('does not bypass disabled settings.set when selecting a provider voice', async () => {
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({
            voice: { providerId, providers: { [providerId]: { schemaVersion: descriptor.schemaVersion,
                config: { ...descriptor.defaultConfig, voice: 'alloy' } } } },
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        }));
        try {
            const screen = await renderScreen(<VoiceFields />);
            const picker = screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'voice-realtime-field-voice');
            if (!picker) throw new Error('Voice field missing');
            await act(async () => picker.props.onSelect('sage'));
            expect(readVoiceProviderSettingsConfig(account.settings.voice, providerId)?.voice).toBe('alloy');
            expect(account.writes).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('saves compound custom models and inline instructions without replacing neighboring provider values', async () => {
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: { providerId,
            providers: { [providerId]: { schemaVersion: descriptor.schemaVersion, config: descriptor.defaultConfig } } } }));
        try {
            const screen = await renderScreen(<VoiceFields paths={['model', 'instructions']} />);
            const model = screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'voice-realtime-field-model');
            if (!model) throw new Error('Model field missing');
            await act(async () => model.props.onSelect('__custom__'));
            const custom = screen.findAllByType(FieldValueItem).find(node => node.props.testID === 'voice-realtime-field-model.custom');
            if (!custom) throw new Error('Custom model input missing');
            const current = readVoiceProviderSettingsConfig(account.settings.voice, providerId);
            act(() => account.replaceVoice({ ...account.settings.voice, providers: { ...account.settings.voice.providers,
                [providerId]: { schemaVersion: descriptor.schemaVersion, config: { ...current, voice: 'sage' } } } }));
            await act(async () => { custom.props.onCommit('gpt-realtime-custom'); });
            await waitForTestEvent(account.subscribe, () => readVoiceProviderSettingsConfig(account.persistedSettings.voice, providerId)?.model,
                value => typeof value === 'object' && value !== null && 'id' in value && value.id === 'gpt-realtime-custom');
            expect(readVoiceProviderSettingsConfig(account.persistedSettings.voice, providerId)?.model)
                .toEqual({ kind: 'pinned', id: 'gpt-realtime-custom' });
            const instructions = screen.findAllByType(FieldValueItem).find(node => node.props.testID === 'voice-realtime-field-instructions');
            if (!instructions) throw new Error('Instructions field missing');
            await act(async () => { instructions.props.onCommit('Be concise'); });
            await waitForTestEvent(account.subscribe, () => readVoiceProviderSettingsConfig(account.persistedSettings.voice, providerId)?.instructions,
                value => value === 'Be concise');
            expect(readVoiceProviderSettingsConfig(account.persistedSettings.voice, providerId))
                .toMatchObject({ instructions: 'Be concise', voice: 'sage', model: { id: 'gpt-realtime-custom' } });
        } finally { standardCleanup(); await account.dispose(); }
    });
    it.each([
        { key: 'speed', value: 1.1, offStep: 1.15 },
        { key: 'similarityBoost', value: 0.65, offStep: 0.655 },
    ])('persists $key, rejects off-step input, and restores its nullable service default', async ({ key, value, offStep }) => {
        const id = elevenlabs.providerId;
        const settings = elevenlabs.providerSettings!;
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: { providerId: id,
            providers: { [id]: { schemaVersion: settings.schemaVersion, config: { ...settings.defaultConfig, billingMode: 'byo' } } } } }));
        try {
            const screen = await renderScreen(<VoiceFields paths={[`tts.voiceSettings.${key}`, 'tts.voiceSettings.useSpeakerBoost']} />);
            expect(screen.findByTestId('voice-realtime-field-tts-voiceSettings-useSpeakerBoost')).toBeNull();
            const slider = screen.findAllByType(Slider)[0];
            if (!slider) throw new Error('Declared Voice range missing');
            await act(async () => { slider.props.onValueChange(value); });
            await waitForTestEvent(account.subscribe, () => readVoiceProviderSettingsConfig(account.persistedSettings.voice, id)?.tts,
                tts => typeof tts === 'object' && tts !== null && 'voiceSettings' in tts
                    && typeof tts.voiceSettings === 'object' && tts.voiceSettings !== null
                    && key in tts.voiceSettings && Reflect.get(tts.voiceSettings, key) === value);
            expect(readVoiceProviderSettingsConfig(account.persistedSettings.voice, id))
                .toMatchObject({ tts: { voiceSettings: { [key]: value } } });
            const writes = account.writes.length;
            await act(async () => { slider.props.onValueChange(offStep); });
            expect(account.writes).toHaveLength(writes);
            const reset = screen.findByTestId(`voice-realtime-field-tts-voiceSettings-${key}.default`);
            if (!reset) throw new Error('Service default control missing');
            await act(async () => { reset.props.onPress(); });
            await waitForTestEvent(account.subscribe, () => readVoiceProviderSettingsConfig(account.persistedSettings.voice, id)?.tts,
                tts => typeof tts === 'object' && tts !== null && 'voiceSettings' in tts
                    && typeof tts.voiceSettings === 'object' && tts.voiceSettings !== null
                    && key in tts.voiceSettings && Reflect.get(tts.voiceSettings, key) === null);
            expect(readVoiceProviderSettingsConfig(account.persistedSettings.voice, id))
                .toMatchObject({ tts: { voiceSettings: { [key]: null } } });
        } finally { standardCleanup(); await account.dispose(); }
    });
    it.each([
        { local: false, disabled: false }, { local: false, disabled: true },
        { local: true, disabled: false }, { local: true, disabled: true },
    ])('retains shared Greeting Action admission (local=$local, disabled=$disabled)', async ({ local, disabled }) => {
        const id = local ? 'local_conversation' : elevenlabs.providerId;
        const settings = elevenlabs.providerSettings!;
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: { providerId: id,
            ...(local ? {} : { providers: { [id]: { schemaVersion: settings.schemaVersion, config: settings.defaultConfig } } }) },
            ...(disabled ? { actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } } : {}),
        }));
        try {
            const screen = await renderScreen(local ? <LocalGreeting /> : <VoiceFields paths={['welcome']} />);
            const greeting = screen.findAllByType(SegmentedChoiceItem).find(node => node.props.testIDPrefix === 'settings.voice.greeting');
            if (!greeting) throw new Error('Greeting missing');
            act(() => account.replaceVoice({ ...account.settings.voice, assistantLanguage: 'fr' }));
            await act(async () => greeting.props.onChange('on_first_turn'));
            if (disabled) {
                expect(resolveVoiceWelcomeSelection(account.settings.voice.welcome)).toBe('off');
                expect(account.writes).toEqual([]);
            } else {
                expect(resolveVoiceWelcomeSelection(account.persistedSettings.voice.welcome)).toBe('on_first_turn');
                expect(account.persistedSettings.voice.assistantLanguage).toBe('fr');
            }
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('encodes declared keyterm arrays and structured custom voices through their existing bindings', async () => {
        const id = xai.providerId;
        const settings = xai.providerSettings!;
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: { providerId: id,
            providers: { [id]: { schemaVersion: settings.schemaVersion, config: settings.defaultConfig } } } }));
        try {
            const screen = await renderScreen(<VoiceFields paths={['transcription.keyterms', 'voice']} />);
            const terms = screen.findAllByType(FieldValueItem).find(node => node.props.testID === 'voice-realtime-field-transcription-keyterms');
            if (!terms) throw new Error('Keyterms missing');
            await act(async () => { terms.props.onCommit('Happier, daemon ,happier'); });
            await waitForTestEvent(account.subscribe, () => readVoiceProviderSettingsConfig(account.persistedSettings.voice, id)?.transcription,
                value => typeof value === 'object' && value !== null && 'keyterms' in value
                    && JSON.stringify(value.keyterms) === JSON.stringify(['happier', 'daemon']));
            expect(readVoiceProviderSettingsConfig(account.persistedSettings.voice, id))
                .toMatchObject({ transcription: { keyterms: ['happier', 'daemon'] } });
            const picker = screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'voice-realtime-field-voice');
            if (!picker) throw new Error('Voice picker missing');
            await act(async () => picker.props.onSelect('__custom__'));
            const custom = screen.findAllByType(FieldValueItem).find(node => node.props.testID === 'voice-realtime-field-voice.custom');
            if (!custom) throw new Error('Custom voice missing');
            await act(async () => { custom.props.onCommit('my-cloned-voice'); });
            await waitForTestEvent(account.subscribe, () => readVoiceProviderSettingsConfig(account.persistedSettings.voice, id)?.voice,
                value => typeof value === 'object' && value !== null && 'id' in value && value.id === 'my-cloned-voice');
            expect(readVoiceProviderSettingsConfig(account.persistedSettings.voice, id))
                .toMatchObject({ voice: { kind: 'custom', id: 'my-cloned-voice' }, transcription: { keyterms: ['happier', 'daemon'] } });
        } finally { standardCleanup(); await account.dispose(); }
    });
    it.each(['approved', 'rejected', 'unavailable'] as const)('settles real provider consent without a duplicate UI writer (%s)', async consent => {
        const id = xai.providerId;
        const settings = xai.providerSettings!;
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: { providerId: id,
            providers: { [id]: { schemaVersion: settings.schemaVersion, config: settings.defaultConfig } } } }));
        modalHostActive = consent !== 'unavailable';
        // The unavailable case exercises the web host's actual absence; native
        // availability cases exercise the OS-presented decision buttons.
        platform.value = consent === 'unavailable' ? 'web' : 'ios';
        // Keep the real absence diagnostic: no fabricated confirm rejection or
        // modal state. The inactive canonical host cannot approve this write.
        const unavailableErrors = consent === 'unavailable' ? vi.spyOn(console, 'error') : null;
        const unavailableReported = createDeferred<void>();
        const reportError = unavailableErrors?.getMockImplementation();
        unavailableErrors?.mockImplementation((...args: unknown[]) => {
            reportError?.(...args);
            if (args.some(arg => typeof arg === 'string' && arg.includes('ModalManager not initialized'))) unavailableReported.resolve();
        });
        try {
            const screen = await renderScreen(<VoiceFields paths={['resumptionEnabled']} />);
            const toggle = screen.findAllByType(Switch)[0];
            if (!toggle) throw new Error('Privacy control missing');
            let eventResult: unknown;
            await act(async () => { eventResult = toggle.props.onValueChange(true); });
            expect(eventResult).toBeUndefined();
            if (consent === 'unavailable') {
                await unavailableReported.promise;
                expect(unavailableErrors).toHaveBeenCalledWith(expect.stringContaining('ModalManager not initialized'));
                // After this actual host refusal, the remaining path consists
                // of promise continuations and the synchronous failure alert.
                await flushHookEffects();
            } else {
                await nextNativeAlert.promise;
                expect(nativeAlert.mock.calls.at(-1)?.[2]?.some(button => button.style === 'cancel')).toBe(true);
                const buttons = nativeAlert.mock.calls.at(-1)?.[2];
                nextNativeAlert = createDeferred<Parameters<typeof Alert.alert>>();
                await act(async () => buttons?.find(button => (button.style === 'cancel') === (consent === 'rejected'))?.onPress?.());
            }
            if (consent === 'approved') {
                await waitForTestEvent(account.subscribe, () => readVoiceProviderSettingsConfig(account.persistedSettings.voice, id)?.resumptionEnabled,
                    value => value === true);
                expect(readVoiceProviderSettingsConfig(account.persistedSettings.voice, id)?.resumptionEnabled).toBe(true);
            }
            else {
                if (consent === 'rejected') {
                    await nextNativeAlert.promise;
                    expect(nativeAlert.mock.calls.at(-1)?.[1]).toBe(tLoose('settingsVoice.realtimeProviders.operationFailed'));
                }
                expect(readVoiceProviderSettingsConfig(account.persistedSettings.voice, id)?.resumptionEnabled).toBe(false);
                expect(account.writes).toEqual([]);
            }
        } finally { standardCleanup(); await account.dispose(); unavailableErrors?.mockRestore(); }
    });
});

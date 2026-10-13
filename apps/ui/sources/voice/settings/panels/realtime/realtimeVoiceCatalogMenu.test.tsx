import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createElevenLabsSettingsRuntimeTestHarness, createVoiceSettingsAccountTestHarness } from '../voiceSettingsAccountTestHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { saveAndUseAccountVoiceCredential } from '@/voice/credentials/accountVoiceCredential';
import { refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import 'fake-indexeddb/auto';
// The actual settings HTTP operation needs no vendor conversation SDK start.
vi.mock('@elevenlabs/client/web', () => ({ Conversation: { startSession: () => { throw new Error('Unexpected ElevenLabs conversation start'); } } }));

vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
const { installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { useRealtimeVoiceCatalog } = await import('./realtimeVoiceCatalogMenu');
const { createBundledConversationUi } = await import('@/voice/credentials/bundledConversationClient');
const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');
const { readDeclaredVoiceSettingsCatalog } = await import('./voiceCatalog');
const { getPreferredLanguage, setPreferredLanguageFromSettings } = await import('@/text');
const initialLanguage = getPreferredLanguage();
const initialStorage = storage.getState();

let runtime: ReturnType<typeof createElevenLabsSettingsRuntimeTestHarness>;
let account: Awaited<ReturnType<typeof createVoiceSettingsAccountTestHarness>>;
let client: NonNullable<ReturnType<typeof createBundledConversationUi>>['client'];
beforeEach(async () => {
  setPreferredLanguageFromSettings('en');
  account = await createVoiceSettingsAccountTestHarness(settingsParse({
    voice: { providerId: 'happier.voice.elevenlabs/realtime-elevenlabs' },
  }));
  runtime = createElevenLabsSettingsRuntimeTestHarness();
  const settingsVersion = storage.getState().settingsVersion;
  if (settingsVersion === null) throw new Error('Expected hydrated Account Settings version');
  account.replaceSettings(saveAndUseAccountVoiceCredential({
    settings: account.settings,
    contribution: { pluginId: runtime.entry.pluginId, localId: runtime.entry.declaration.id },
    credentialSlotId: 'api_key', currentDeclaration: runtime.entry.declaration,
    expectedSettingsVersion: settingsVersion,
    value: 'test-only-catalog-key', generateId: () => 'catalog-secret', now: 1,
    expectedSecretId: null, expectedSecretUpdatedAt: null,
  }).settings);
  await refreshSavedSecretCatalog(account.scope);
  await runtime.register();
  const ui = createBundledConversationUi(runtime.registration.providerId);
  if (!ui?.client) throw new Error('Shipped provider catalog client missing');
  client = ui.client;
});
afterEach(async () => { standardCleanup(); await runtime.dispose(); await account.dispose(); storage.setState(initialStorage, true); });
afterAll(() => { setPreferredLanguageFromSettings(initialLanguage); });

describe('the shared realtime voice catalog', () => {
  it('uses a provider-declared static catalog without contacting the catalog transport', async () => {
    const entry = createDefaultVoiceProviderRegistry().list().find(candidate => 'declaration' in candidate && candidate.declaration?.id === 'realtime-openai');
    if (!entry || !('declaration' in entry) || !entry.declaration) throw new Error('OpenAI Voice declaration missing');
    const rows = readDeclaredVoiceSettingsCatalog(entry.declaration);
    if (!rows?.length) throw new Error('Provider-declared voice options missing');
    runtime.fetch.mockRejectedValue(new Error('static catalog must not request transport'));
    const params = { client, credentialUsable: true, targetKey: 'declared-static-catalog', declaredRows: rows };
    const picker = await renderHook(() => useRealtimeVoiceCatalog(params));
    expect(picker.getCurrent().catalog).toEqual({ phase: 'ready', rows });
    await act(async () => picker.getCurrent().requestCatalog());
    expect(runtime.fetch).not.toHaveBeenCalled();
  });

  it('retains names for a closed picker across remounts without fetching, scoped to its target', async () => {
    runtime.fetch.mockImplementation(async () => runtime.response({ voices: [{ voice_id: 'voice-catalog-1', name: 'Sage' }] }));
    const params = { client, credentialUsable: true, targetKey: 'retained-catalog-target' };
    const picker = await renderHook(() => useRealtimeVoiceCatalog(params));
    expect(runtime.fetch).not.toHaveBeenCalled();
    await act(async () => picker.getCurrent().requestCatalog());
    await vi.waitFor(() => expect(picker.getCurrent().catalog.phase).toBe('ready'));
    await picker.unmount();

    const closed = await renderHook((targetKey: string) => useRealtimeVoiceCatalog({ ...params, targetKey }), {
      initialProps: params.targetKey,
    });
    expect(closed.getCurrent().lastKnownRows).toEqual([{ id: 'voice-catalog-1', name: 'Sage', previewUrl: null }]);
    const voiceRequests = () => runtime.fetch.mock.calls.filter(([request, init]) =>
      init?.method === 'GET' && new URL(request instanceof Request ? request.url : String(request)).pathname === '/v1/voices');
    expect(voiceRequests()).toHaveLength(1);
    await closed.rerender('different-credential-target');
    expect(closed.getCurrent().lastKnownRows).toBeNull();
    expect(voiceRequests()).toHaveLength(1);
  });

  it('updates a closed reader through the same owner and keeps the known name after a failed refresh', async () => {
    runtime.fetch.mockImplementation(async () => runtime.response({ voices: [{ voice_id: 'voice-catalog-2', name: 'Marin' }] }));
    const params = { client, credentialUsable: true, targetKey: 'shared-catalog-target' };
    const closed = await renderHook(() => useRealtimeVoiceCatalog(params));
    const picker = await renderHook(() => useRealtimeVoiceCatalog(params));
    await act(async () => picker.getCurrent().requestCatalog());
    await vi.waitFor(() => expect(closed.getCurrent().lastKnownRows?.[0]?.name).toBe('Marin'));
    runtime.fetch.mockRejectedValueOnce(new Error('catalog transport unavailable'));
    await act(async () => picker.getCurrent().requestCatalog());
    await vi.waitFor(() => expect(picker.getCurrent().catalog.phase).toBe('error'));
    expect(closed.getCurrent().lastKnownRows?.[0]?.name).toBe('Marin');
    expect(picker.getCurrent().lastKnownRows?.[0]?.name).toBe('Marin');
    await act(async () => picker.getCurrent().resetCatalog());
    expect(closed.getCurrent().lastKnownRows).toBeNull();
  });
});

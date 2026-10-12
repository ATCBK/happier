import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { settingsParse } from '@/sync/domains/settings/settings';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { updateEffectiveHomeViewState } from '@/sync/domains/server/selection/homeViewSelectionState';
import { storage } from '@/sync/domains/state/storage';
import { readLocalConversationVoiceSettings, voiceSettingsParse, writeLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { createVoiceSettingsAccountTestHarness } from '@/voice/settings/panels/voiceSettingsAccountTestHarness';
import { installVoiceSettingsPanelCommonModuleMocks } from '@/voice/settings/panels/voiceSettingsPanelTestHelpers';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { useBundledConversationProviderSettings } from '@/voice/settings/panels/realtime/useBundledConversationProviderSettings';
import { useRealtimeVoiceCatalog } from '@/voice/settings/panels/realtime/realtimeVoiceCatalogMenu';

// Eager Account harness imports precede the common mock installer's options;
// keep the real store from the first import rather than its default stub.
vi.mock('@/sync/domains/state/storage', async () =>
  vi.importActual<typeof import('@/sync/domains/state/storage')>('@/sync/domains/state/storage'));

installVoiceSettingsPanelCommonModuleMocks({
  storage: () => vi.importActual<typeof import('@/sync/domains/state/storage')>('@/sync/domains/state/storage'),
  text: async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key });
  },
});
vi.doUnmock('@/sync/domains/state/storage');
vi.doMock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key });
});
// Install the genuine transport boundary before eager Account harness imports.
vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
const initialState = storage.getState();
afterEach(() => { standardCleanup(); resetServerFeaturesClientForTests(); storage.setState(initialState, true); });
const { SessionVoiceSection } = await import('./SessionVoiceSection');

describe('Work voice source display', () => {
  it('names the OpenAI default from its declaration before the catalog picker opens', async () => {
    const voice = voiceSettingsParse({ providerId: 'happier.voice.openai/realtime-openai' });
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({
      experiments: true, featureToggles: { voice: true }, voiceSettingsV1: voice,
    }));
    try {
      await updateEffectiveHomeViewState(() => ({ version: 1, groups: [], activeTargetKind: 'server', activeTargetId: account.scope.serverId }), { scope: 'device' });
      expect(await getServerFeaturesSnapshot({ serverId: account.scope.serverId, force: true })).toMatchObject({ status: 'ready' });
      const screen = await renderScreen(<SessionVoiceSection session={createSessionFixture({ serverId: account.scope.serverId })} serverId={account.scope.serverId} />);
      await vi.waitFor(() => expect(screen.findAllByType(DropdownMenu)).toHaveLength(1));
      const picker = screen.findByType(DropdownMenu);
      expect(picker.props.open).toBe(false);
      expect(picker.props.itemTrigger.detailFormatter()).toBe('Marin · settingsVoice.mode.openaiRealtime');
    } finally { await account.dispose(); }
  });

  it('uses the retained provider catalog name in the closed field before this picker opens', async () => {
    const providerId = 'happier.voice.google/google-cloud-tts';
    const entry = createDefaultVoiceProviderRegistry().get(providerId);
    if (!entry?.providerSettings) throw new Error('Google settings declaration missing');
    const base = voiceSettingsParse({ providerId: 'local_conversation', providers: {
      [providerId]: { schemaVersion: entry.providerSettings.schemaVersion,
        config: { ...entry.providerSettings.defaultConfig, voiceName: 'en-US-Neural2-C' } },
    } });
    const config = readLocalConversationVoiceSettings(base);
    const voice = writeLocalConversationVoiceSettings(base, { ...config, tts: { ...config.tts, provider: providerId } });
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({
      experiments: true, featureToggles: { voice: true }, voiceSettingsV1: voice,
    }));
    try {
      await updateEffectiveHomeViewState(() => ({ version: 1, groups: [], activeTargetKind: 'server', activeTargetId: account.scope.serverId }), { scope: 'device' });
      expect(await getServerFeaturesSnapshot({ serverId: account.scope.serverId, force: true })).toMatchObject({ status: 'ready' });
      const settings = await renderHook(() => useBundledConversationProviderSettings(voice));
      const choice = settings.getCurrent().sessionChoice;
      if (!choice) throw new Error('Session voice choice missing');
      // Catalog transport boundary: the real shared owner retains the fetched provider row.
      const fetchVoiceCatalog = vi.fn(async () => [{ id: 'en-US-Neural2-C', name: 'Neural C' }]);
      const previousPicker = await renderHook(() => useRealtimeVoiceCatalog({
        client: { fetchVoiceCatalog }, credentialUsable: true, targetKey: choice.targetKey,
      }));
      await act(async () => previousPicker.getCurrent().requestCatalog());
      await vi.waitFor(() => expect(previousPicker.getCurrent().catalog.phase).toBe('ready'));
      await previousPicker.unmount();
      const screen = await renderScreen(<SessionVoiceSection session={createSessionFixture({ serverId: account.scope.serverId })} serverId={account.scope.serverId} />);
      await vi.waitFor(() => expect(screen.findAllByType(DropdownMenu)).toHaveLength(1));
      const picker = screen.findByType(DropdownMenu);
      expect(picker.props.open).toBe(false);
      expect(picker.props.itemTrigger.detailFormatter()).toBe('Neural C · settingsVoice.local.googleCloudTts.provider.title');
      expect(fetchVoiceCatalog).toHaveBeenCalledTimes(1);
    } finally { await account.dispose(); }
  });

  it.each([
    { voiceId: 'en-US-Neural2-A', displayName: undefined, expectedName: 'en-US-Neural2-A' },
    { voiceId: 'en-US-Neural2-D', displayName: 'Neural D', expectedName: 'Neural D' },
  ])('names the closed Google speech choice without requiring its catalog ($expectedName)', async ({ voiceId, displayName, expectedName }) => {
    const providerId = 'happier.voice.google/google-cloud-tts';
    const entry = createDefaultVoiceProviderRegistry().get(providerId);
    if (!entry?.providerSettings) throw new Error('Google settings declaration missing');
    const base = voiceSettingsParse({ providerId: 'local_conversation', providers: {
      [providerId]: { schemaVersion: entry.providerSettings.schemaVersion,
        config: { ...entry.providerSettings.defaultConfig, voiceName: voiceId } },
    } });
    const config = readLocalConversationVoiceSettings(base);
    const voice = writeLocalConversationVoiceSettings(base, { ...config, tts: { ...config.tts, provider: providerId } });
    resetServerFeaturesClientForTests();
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({
      experiments: true, featureToggles: { voice: true }, voiceSettingsV1: voice,
    }));
    try {
      await updateEffectiveHomeViewState(() => ({ version: 1, groups: [], activeTargetKind: 'server', activeTargetId: account.scope.serverId }), { scope: 'device' });
      expect(await getServerFeaturesSnapshot({ serverId: account.scope.serverId, force: true })).toMatchObject({ status: 'ready' });
      const session = createSessionFixture({ serverId: account.scope.serverId });
      if (displayName) {
        session.metadata = { ...session.metadata!, work: { voicePreference: {
          providerContributionId: providerId, settingFieldPath: 'voiceName', value: voiceId, displayName,
        } } };
      }
      const screen = await renderScreen(<SessionVoiceSection session={session} serverId={account.scope.serverId} />);
      await vi.waitFor(() => expect(screen.findAllByType(DropdownMenu)).toHaveLength(1));
      const picker = screen.findByType(DropdownMenu);
      const provider = 'settingsVoice.local.googleCloudTts.provider.title';
      expect(picker.props.itemTrigger.detailFormatter()).toBe(`${expectedName} · ${provider}`);
      expect(picker.props.items.find((item: { id: string }) => item.id === '__follow__').subtitle)
        .toBe(`sessionVoice.accountVoice:${JSON.stringify({ voice: expectedName, provider })}`);
    } finally { await account.dispose(); }
  });
});

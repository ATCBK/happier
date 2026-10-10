import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { updateEffectiveHomeViewState } from '@/sync/domains/server/selection/homeViewSelectionState';
import { storage } from '@/sync/domains/state/storage';
import { readLocalConversationVoiceSettings, voiceSettingsParse, writeLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { createVoiceSettingsAccountTestHarness } from '@/voice/settings/panels/voiceSettingsAccountTestHarness';
import { installVoiceSettingsPanelCommonModuleMocks } from '@/voice/settings/panels/voiceSettingsPanelTestHelpers';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';

installVoiceSettingsPanelCommonModuleMocks({
  storage: () => vi.importActual<typeof import('@/sync/domains/state/storage')>('@/sync/domains/state/storage'),
  text: async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key });
  },
});
installDisconnectedServerSocketBoundary();
const initialState = storage.getState();
afterEach(() => { standardCleanup(); resetServerFeaturesClientForTests(); storage.setState(initialState, true); });
const { SessionVoiceSection } = await import('./SessionVoiceSection');

describe('Work voice source display', () => {
  it('names Google speech in the field and account-following subtitle when the conversation is Local', async () => {
    const providerId = 'happier.voice.google/google-cloud-tts';
    const entry = createDefaultVoiceProviderRegistry().get(providerId);
    if (!entry?.providerSettings) throw new Error('Google settings declaration missing');
    const base = voiceSettingsParse({ providerId: 'local_conversation', providers: {
      [providerId]: { schemaVersion: entry.providerSettings.schemaVersion,
        config: { ...entry.providerSettings.defaultConfig, voiceName: 'en-US-Neural2-C' } },
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
      const screen = await renderScreen(<SessionVoiceSection session={session} serverId={account.scope.serverId} />);
      await vi.waitFor(() => expect(screen.findAllByType(DropdownMenu)).toHaveLength(1));
      const picker = screen.findByType(DropdownMenu);
      const provider = 'settingsVoice.local.googleCloudTts.provider.title';
      expect(picker.props.itemTrigger.detailFormatter()).toBe(`en-US-Neural2-C · ${provider}`);
      expect(picker.props.items.find((item: { id: string }) => item.id === '__follow__').subtitle)
        .toBe(`sessionVoice.accountVoice:${JSON.stringify({ voice: 'en-US-Neural2-C', provider })}`);
    } finally { await account.dispose(); }
  });
});

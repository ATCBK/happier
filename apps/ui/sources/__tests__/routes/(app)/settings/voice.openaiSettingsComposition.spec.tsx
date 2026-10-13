import React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { createVoiceSettingsAccountTestHarness } from '@/voice/settings/panels/voiceSettingsAccountTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { readVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { storage } from '@/sync/domains/state/storage';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';

vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
installDisconnectedServerSocketBoundary();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const originalState = storage.getState();
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { VoiceConversationsSettingsScreen } = await import('@/voice/settings/screens/VoiceConversationsSettingsScreen');
const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');
afterEach(() => { standardCleanup(); storage.setState(originalState, true); });

describe('VoiceSettingsScreen OpenAI settings composition', () => {
  it('persists the single declared Turn detection control through Account settings admission', async () => {
    const providerId = 'happier.voice.openai/realtime-openai';
    const descriptor = createDefaultVoiceProviderRegistry().get(providerId)?.providerSettings;
    if (!descriptor) throw new Error('OpenAI declared Voice settings missing');
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: {
      providerId, providers: { [providerId]: { schemaVersion: descriptor.schemaVersion, config: descriptor.defaultConfig } },
    } }));
    try {
      const screen = await renderSettingsView(<InjectedAuthProvider credentials={account.credentials}><VoiceConversationsSettingsScreen /></InjectedAuthProvider>);
      expect(descriptor.presentation).toMatchObject({
        fields: expect.arrayContaining([expect.objectContaining({ kind: 'select', path: 'turnDetection' })]),
      });
      const controls = screen.tree.findAllByType(DropdownMenu)
        .filter(node => node.props.testID === 'voice-realtime-field-turnDetection');
      expect(controls).toHaveLength(1);
      act(() => account.replaceVoice({ ...account.settings.voice, assistantLanguage: 'fr' }));
      await act(async () => controls[0]!.props.onSelect('manual'));
      await vi.waitFor(() => expect(readVoiceProviderSettingsConfig(account.persistedSettings.voice, providerId))
        .toMatchObject({ turnDetection: 'manual' }));
      expect(account.persistedSettings.voice.assistantLanguage).toBe('fr');
    } finally { standardCleanup(); await account.dispose(); }
  });
});

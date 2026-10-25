import React from 'react';
import 'fake-indexeddb/auto';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';

import { renderSettingsView, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { createVoiceSettingsAccountTestHarness } from '@/voice/settings/panels/voiceSettingsAccountTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { Modal, ModalProvider } from '@/modal';
import { NewSessionConnectedServicesSelectionContent } from '@/components/sessions/new/components/NewSessionConnectedServicesSelectionContent';
import { createConnectedServiceOptionId } from '@/components/sessions/new/components/buildNewSessionConnectedServicesSelectionListModel';
import { storage } from '@/sync/domains/state/storage';
import { writeVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';

vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// Only renderer/DOM host leaves are synthetic; the modal stack and picker stay real.
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
vi.mock('@/utils/web/reactDomCjs', () => ({ requireReactDOM: () => ({ createPortal: (children: React.ReactNode) => children }) }));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
installDisconnectedServerSocketBoundary();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { VoiceGlobalConnectedServicesBindingField } = await import('@/voice/settings/panels/realtime/VoiceGlobalConnectedServicesBindingField');
const { VoiceConversationsSettingsScreen } = await import('@/voice/settings/screens/VoiceConversationsSettingsScreen');

describe('VoiceSettingsScreen Codex settings composition', () => {
  it('renders one real interactive Codex Account field from the public settings contribution', async () => {
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: {
      providerId: 'happier.agent.codex/realtime-codex', providers: {
        'happier.agent.codex/realtime-codex': { schemaVersion: 2, config: { globalConnectedServices: null } },
      },
    } }));
    try {
      const providerId = 'happier.agent.codex/realtime-codex';
      const serviceId = 'happier.agent.codex/openai-codex';
      storage.getState().applyProfile(AccountProfileSchema.parse({ ...storage.getState().profile,
        connectedServicesV2: [{ serviceId: 'openai-codex', profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth' }] }],
      }));
      const screen = await renderSettingsView(<InjectedAuthProvider credentials={account.credentials}><ModalProvider><VoiceConversationsSettingsScreen /></ModalProvider></InjectedAuthProvider>);
      const accountFields = screen.tree.findAllByType(VoiceGlobalConnectedServicesBindingField);
      expect(accountFields).toHaveLength(1);
      expect(accountFields[0]!.props).toMatchObject({
        title: 'Codex account', agentId: { pluginId: 'happier.agent.codex', localId: 'codex' }, serviceIds: ['openai-codex'],
      });
      await screen.pressByTestIdAsync('voice-realtime-connected-services-codex');
      expect(screen.tree.findByType(NewSessionConnectedServicesSelectionContent).props.supportedServiceIds).toEqual(['openai-codex']);
      expect(screen.findHostByTestId('voice-realtime-connected-services-modal-codex')).toBeTruthy();
      const optionId = createConnectedServiceOptionId('openai-codex', 'work');
      const choose = async () => {
        const options = () => screen.tree.findAll(node => typeof node.type === 'string'
          && typeof node.props.onPress === 'function' && node.props.testID?.endsWith(`:option:${optionId}`));
        await waitForTestEvent(screen.subscribe, () => expect(options()).toHaveLength(1));
        await act(async () => { options()[0]!.props.onPress(); });
      };
      await choose();
      await waitForTestEvent(account.subscribe, () => expect(account.persistedSettings.voice.providers[providerId]?.config)
        .toMatchObject({ globalConnectedServices: { v: 1, bindingsByServiceId: {
          [serviceId]: { source: 'connected', selection: 'profile', profileId: 'work' },
        } } }));
      await act(async () => { screen.tree.findByType(NewSessionConnectedServicesSelectionContent).props.requestClose(); });
      await act(async () => {
        account.replaceVoice(writeVoiceProviderSettingsConfig(account.settings.voice, providerId, { globalConnectedServices: null }));
        account.replaceSettings(settingsParse({ ...account.settings, actionsSettingsV1: {
          v: 1, actions: { 'settings.invoke': { disabledSurfaces: ['ui'] } },
        } }), { version: (storage.getState().settingsVersion ?? 0) + 1 });
      });
      const notice = vi.spyOn(Modal, 'alert'); // Observe the genuine presentation boundary without replacing it.
      onTestFinished(() => notice.mockRestore());
      const writesBeforeDisabledGesture = account.settingsWrites.length;
      await screen.pressByTestIdAsync('voice-realtime-connected-services-codex');
      await choose();
      await waitForTestEvent(listener => {
        const stopAccount = account.subscribe(listener);
        const stopScreen = screen.subscribe(listener);
        return () => { stopAccount(); stopScreen(); };
      }, () => ({ notices: notice.mock.calls.length, writes: account.settingsWrites.length }),
      state => state.notices > 0 || state.writes > writesBeforeDisabledGesture);
      expect(notice).toHaveBeenCalled();
      expect(account.settingsWrites).toHaveLength(writesBeforeDisabledGesture);
      expect(account.persistedSettings.voice.providers[providerId]?.config).toMatchObject({ globalConnectedServices: null });
    } finally { standardCleanup(); await account.dispose(); }
  });
});

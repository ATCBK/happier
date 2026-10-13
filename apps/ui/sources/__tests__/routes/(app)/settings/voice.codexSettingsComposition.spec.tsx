import React from 'react';
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { createVoiceSettingsAccountTestHarness } from '@/voice/settings/panels/voiceSettingsAccountTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { ModalProvider } from '@/modal';
import { NewSessionConnectedServicesSelectionContent } from '@/components/sessions/new/components/NewSessionConnectedServicesSelectionContent';

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
      const screen = await renderSettingsView(<InjectedAuthProvider credentials={account.credentials}><ModalProvider><VoiceConversationsSettingsScreen /></ModalProvider></InjectedAuthProvider>);
      const accountFields = screen.tree.findAllByType(VoiceGlobalConnectedServicesBindingField);
      expect(accountFields).toHaveLength(1);
      expect(accountFields[0]!.props).toMatchObject({
        title: 'Codex account', agentId: { pluginId: 'happier.agent.codex', localId: 'codex' }, serviceIds: ['openai-codex'],
      });
      await screen.pressByTestIdAsync('voice-realtime-connected-services-codex');
      expect(screen.tree.findByType(NewSessionConnectedServicesSelectionContent).props.supportedServiceIds).toEqual(['openai-codex']);
      expect(screen.findHostByTestId('voice-realtime-connected-services-modal-codex')).toBeTruthy();
    } finally { standardCleanup(); await account.dispose(); }
  });
});

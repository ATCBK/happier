import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  ConnectedServiceBindingsV1Schema,
  ConnectedServiceBindingsV2Schema,
  PluginContributesV2Schema,
  readBuiltInLegacyConnectedAccountServiceKeyIngress,
} from '@happier-dev/protocol';

import { renderScreen as renderTestScreen } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { Item } from '@/components/ui/lists/Item';
import { NewSessionConnectedServicesSelectionContent } from '@/components/sessions/new/components/NewSessionConnectedServicesSelectionContent';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createVoiceSettingsAccountTestHarness } from '../voiceSettingsAccountTestHarness';

function renderScreen(element: React.ReactElement) {
  return renderTestScreen(<InjectedAuthProvider credentials={null}>{element}</InjectedAuthProvider>);
}

const profileState = {
  get connectedServicesV2() { return storage.getState().profile.connectedServicesV2; },
  set connectedServicesV2(value: Array<{
    serviceId: string;
    profiles: Array<{
      profileId: string;
      status: 'connected';
      kind: 'oauth' | 'token';
      providerEmail: string;
    }>;
  }>) { storage.setState((state) => ({ profile: { ...state.profile, connectedServicesV2: value } })); },
};
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
const modalShow = vi.hoisted(() => vi.fn());

vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock().module;
});
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ spies: { show: modalShow } }).module;
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});

describe('VoiceGlobalConnectedServicesBindingField', () => {
  beforeEach(async () => {
    const account = await createVoiceSettingsAccountTestHarness(settingsDefaults);
    onTestFinished(account.dispose);
    profileState.connectedServicesV2 = [];
    modalShow.mockClear();
  });

  it('keeps the declared core binding interactive when optional account groups are disabled', async () => {
    const { VoiceGlobalConnectedServicesBindingField } = await import(
      './VoiceGlobalConnectedServicesBindingField'
    );
    const screen = await renderScreen(<VoiceGlobalConnectedServicesBindingField
      agentId="codex"
      serviceIds={['openai-codex']}
      title="Codex account"
      subtitle="Account used for global Codex Voice"
      value={null}
      onChange={vi.fn()}
    />);

    const item = screen.tree.findByType(Item);
    expect(item.props).toMatchObject({
      testID: 'voice-realtime-connected-services-codex',
      title: 'Codex account',
      subtitle: 'Account used for global Codex Voice',
      detail: 'common.none',
      showChevron: true,
    });
    expect(item.props.onPress).toEqual(expect.any(Function));

    act(() => item.props.onPress());
    const modalConfig = modalShow.mock.calls[0]?.[0] as {
      component: React.ComponentType<Record<string, unknown>>;
      props: Record<string, unknown>;
    } | undefined;
    expect(modalConfig).toBeDefined();
    if (!modalConfig) throw new Error('expected Connected Services picker modal');
    const pickerScreen = await renderScreen(React.createElement(
      modalConfig.component,
      { ...modalConfig.props, onClose: vi.fn() },
    ));
    expect(pickerScreen.tree.findByType(NewSessionConnectedServicesSelectionContent).props).toMatchObject({
      bindingsByServiceId: {},
      allowDefaultProfileFallback: false,
      includeNativeAuthOption: false,
    });
  });

  it.each([
    {
      caseName: 'the bundled Agent metadata omits the declared service',
      serviceId: 'anthropic',
      profileId: 'anthropic-work',
      kind: 'token' as const,
    },
    {
      caseName: 'the bundled Agent metadata marks the healthy profile kind unsupported',
      serviceId: 'openai-codex',
      profileId: 'codex-token',
      kind: 'token' as const,
    },
  ])('shows and selects the healthy Voice-declared profile when $caseName', async ({
    serviceId,
    profileId,
    kind,
  }) => {
    profileState.connectedServicesV2 = [{
      serviceId,
      profiles: [{
        profileId,
        status: 'connected',
        kind,
        providerEmail: `${profileId}@example.com`,
      }],
    }];
    const onChange = vi.fn();
    const { VoiceGlobalConnectedServicesBindingField } = await import(
      './VoiceGlobalConnectedServicesBindingField'
    );
    const screen = await renderScreen(<VoiceGlobalConnectedServicesBindingField
      agentId="codex"
      serviceIds={[serviceId]}
      title="Voice account"
      value={null}
      onChange={onChange}
    />);

    const item = screen.tree.findByType(Item);
    expect(item.props.onPress).toEqual(expect.any(Function));
    act(() => item.props.onPress());

    const modalConfig = modalShow.mock.calls[0]?.[0] as {
      component: React.ComponentType<Record<string, unknown>>;
      props: Record<string, unknown>;
    } | undefined;
    expect(modalConfig).toBeDefined();
    if (!modalConfig) throw new Error('expected Connected Services picker modal');
    // StrictMode replays functional state updaters, which is the cheapest real
    // reproduction of React evaluating one more than once. Persistence is an
    // external side effect, so a single selection must still write exactly once.
    const pickerScreen = await renderScreen(React.createElement(
      React.StrictMode,
      null,
      React.createElement(
        modalConfig.component,
        { ...modalConfig.props, onClose: vi.fn() },
      ),
    ));
    const picker = pickerScreen.tree.findByType(NewSessionConnectedServicesSelectionContent);

    expect(picker.props.supportedServiceIds).toEqual([serviceId]);
    expect(picker.props.profileOptionsByServiceId[serviceId]).toEqual([
      expect.objectContaining({
        profileId,
        status: 'connected',
        kind,
      }),
    ]);

    act(() => picker.props.setBindingForService(serviceId, {
      source: 'connected',
      selection: 'profile',
      profileId,
    }));
    const qualifiedServiceId = readBuiltInLegacyConnectedAccountServiceKeyIngress(serviceId);
    expect(qualifiedServiceId).not.toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
    const emittedBinding = onChange.mock.calls[0]?.[0];
    expect(emittedBinding).toEqual({
      v: 1,
      bindingsByServiceId: {
        [qualifiedServiceId!]: {
          source: 'connected',
          selection: 'profile',
          profileId,
        },
      },
    });
    expect(ConnectedServiceBindingsV1Schema.safeParse(emittedBinding).success).toBe(true);
    expect(ConnectedServiceBindingsV2Schema.safeParse(emittedBinding).success).toBe(false);
  });

  it('uses a schema-valid installed qualified Agent without falling back through its colliding bundled local id', async () => {
    const { VoiceGlobalConnectedServicesBindingField } = await import(
      './VoiceGlobalConnectedServicesBindingField'
    );
    const pluginId = 'acme.installed-agent';
    const contributions = PluginContributesV2Schema.parse({
      agents: [{
        id: 'claude',
        title: 'Installed Agent',
        runtime: { kind: 'custom' },
        primary: 'sessions',
        connectedAccounts: [{
          purpose: 'primary',
          service: {
            pluginId: 'happier.agent.codex',
            localId: 'openai-codex',
          },
          required: false,
        }],
        capabilities: {
          sessions: {
            open: ['create'],
            delivery: ['newTurn'],
            cancel: true,
          },
        },
      }],
      voiceProviders: [{
        id: 'conversation',
        title: 'Installed Agent Voice',
        kind: 'conversation',
        roles: ['realtime_conversation'],
        platforms: ['web'],
        capabilities: {
          turn: { cancelResponse: false, bargeIn: false },
        },
        execution: {
          kind: 'experimental_agent_session_realtime',
          agent: 'claude',
          supportedRuntimeVersions: ['1.2.3'],
        },
        settings: {
          schemaVersion: 2,
          fields: [],
          connectedServicesBinding: {
            id: 'globalConnectedServices',
            title: 'Installed Agent account',
            agent: 'claude',
            serviceIds: ['openai-codex'],
          },
        },
        client: {
          artifactId: 'voice-runtime-web',
          exportName: 'activate',
        },
      }],
    });
    const installedAgent = contributions.agents[0]!;
    const installedVoiceProvider = contributions.voiceProviders[0]!;
    if (
      installedVoiceProvider.kind !== 'conversation'
      || !installedVoiceProvider.settings?.connectedServicesBinding
    ) {
      throw new Error('expected installed Agent-session Voice declaration');
    }
    const installedBinding = installedVoiceProvider.settings.connectedServicesBinding;
    const screen = await renderScreen(<VoiceGlobalConnectedServicesBindingField
      agentId={{ pluginId, localId: installedAgent.id }}
      serviceIds={installedBinding.serviceIds}
      title="Installed Agent account"
      value={null}
      onChange={vi.fn()}
    />);

    expect(screen.tree.findByType(Item).props).toMatchObject({
      title: 'Installed Agent account',
      detail: 'common.none',
      showChevron: true,
      onPress: expect.any(Function),
    });
  });
});

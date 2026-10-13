import React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import {
  PluginContributesV2Schema, createRecipientContractDigestV1,
  createVoiceProviderRecipientContractFromCredentialsV1, type VoiceProviderContribution,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { settingsParse } from '@/sync/domains/settings/settings';
import { VoiceSettingsPersistenceV1Schema } from '@/sync/domains/settings/voiceSettingsPersistence';
import { storage } from '@/sync/domains/state/storage';
import { createVoiceSettingsAccountTestHarness } from '@/voice/settings/panels/voiceSettingsAccountTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { ModalProvider } from '@/modal';
import { t, tLoose } from '@/text';

vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// Only third-party renderer/portal leaves are replaced, not approval or modal state.
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
vi.mock('@/utils/web/reactDomCjs', () => ({ requireReactDOM: () => ({ createPortal: (children: React.ReactNode) => children }) }));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
installDisconnectedServerSocketBoundary();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const originalState = storage.getState();
const { VoiceCredentialItem } = await import('@/voice/credentials/CredentialItem');
const { resolveAccountVoiceCredentialApprovalDigest } = await import('@/voice/credentials/accountVoiceCredential');
const { refreshSavedSecretCatalog } = await import('@/sync/engine/settings/savedSecretCatalogEngine');
const { resolveSavedSecretReference } = await import('@/sync/store/settings/savedSecretCatalogSnapshot');
const { VoiceConversationsSettingsScreen } = await import('@/voice/settings/screens/VoiceConversationsSettingsScreen');

function requireConversationDeclaration(
  declaration: VoiceProviderContribution,
) {
  if (declaration.kind !== 'conversation') throw new Error('expected conversation declaration');
  return declaration;
}

function createProviderLeaf() {
  return {
    kind: 'conversation' as const,
    protocol: {
      async prepare() {
        return { kind: 'prepared' as const, session: { config: {}, safeMetadata: null } };
      },
      decodeControl: () => [],
      encodeTurnControl: () => null,
    },
    async createConnection() {
      return {
        kind: 'sdk_handle' as const,
        async connect() {},
        async sendControl() {},
        controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
        transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
        async close() {},
        state: () => 'closed' as const,
        currentProviderSessionId: () => null,
        playbackCursorMs: () => null,
        beginOutputInterruptionCandidate: () => 'unsupported' as const,
        resolveOutputInterruptionCandidate() {},
      };
    },
    encodeToolResults: () => [],
    encodeToolContinuation: () => null,
    encodeContextUpdate: () => [],
    encodeTextTurn: () => [],
    microphoneMode: 'provider_managed' as const,
    setInputMuted: () => {},
  };
}

const declaration = requireConversationDeclaration(PluginContributesV2Schema.parse({
  voiceProviders: [{
    id: 'conversation',
    title: 'Acme Voice',
    kind: 'conversation',
    roles: ['realtime_conversation'],
    platforms: ['web'],
    capabilities: {
      turn: { cancelResponse: true, bargeIn: false },
    },
    credentials: {
      slot: { id: 'api_key', purpose: 'voice.client-auth', title: 'API key' },
      requirement: { kind: 'always' },
      sources: [{
        kind: 'savedSecret',
        secretKinds: ['apiKey'],
        operationProjections: [{
          kind: 'recipientCredential',
          operation: 'client-auth',
          phase: 'prepare',
          format: 'bearer',
        }],
      }],
      hostMediated: { operations: [{
        id: 'client-auth',
        purpose: 'voice.client-auth',
        credentialSlotId: 'api_key',
        effect: 'read',
        request: {
          origin: 'https://voice.example.test',
          pathTemplate: '/v1/session',
          queryTemplate: [],
          headerTemplate: [],
          bodyTemplate: { kind: 'none' },
          method: 'POST',
          credential: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
          redirect: 'error',
          maxBodyBytes: 0,
          contentTypes: [],
        },
        parameters: {
          schema: { type: 'object', properties: {}, additionalProperties: false },
          mapping: [],
        },
        response: { maxBytes: 64 * 1024, contentTypes: ['application/json'] },
      }] },
    },
    client: {
      artifactId: 'voice-runtime-web',
      exportName: 'activate',
    },
  }],
}).voiceProviders[0]!);

const recipientContract = createVoiceProviderRecipientContractFromCredentialsV1({
  package: {
    pluginId: 'acme.voice',
    source: { kind: 'package', locator: 'acme.voice' },
  },
  publisher: {
    trust: 'verified',
    identity: 'package:acme.voice',
  },
  contribution: {
    pluginId: 'acme.voice',
    localId: declaration.id,
  },
  credentials: {
    slot: declaration.credentials!.slot,
    hostMediated: declaration.credentials!.hostMediated!,
  },
  presentation: { title: declaration.title },
});
const recipientContractDigest = createRecipientContractDigestV1(recipientContract);

async function activateCredentialProvider() {
  const { createExternalVoiceProviderActivationScope } = await import('@/voice/registry/externalVoiceProviderActivation.testkit');
  const { createBundledConversationRuntimeHostLease } = await import('@/voice/registry/bundledConversationRuntimeHost');
  const hostLease = createBundledConversationRuntimeHostLease();
  const scope = createExternalVoiceProviderActivationScope({
    pluginId: 'acme.voice',
    occurrenceId: 'acme-voice-activation-occurrence',
    declarations: [declaration],
    hostPlatform: 'web',
    recipientContractsByLocalId: {
      [declaration.id]: recipientContract,
    },
  });
  onTestFinished(async () => {
    await scope.unwind();
    hostLease.revoke();
  });
  scope.api.voiceProviders.register(declaration.id, createProviderLeaf());
  await scope.commit();
}

const providerId = 'acme.voice/conversation';

function routeSettings(input: Readonly<{
  secrets?: readonly unknown[];
  credentialBindings?: readonly unknown[];
}>) {
  const settings = settingsParse({
    secrets: input.secrets ?? [],
    voice: {
      providerId,
      executionMachine: { mode: 'fixed', machineId: 'selected-daemon-that-must-not-own-client-credentials' },
      providers: {
        [providerId]: { schemaVersion: 1, config: {} },
      },
      credentialBindings: input.credentialBindings ?? [],
    },
  });
  // Routine Voice preference edits deliberately retain the existing credential
  // owner. This fixture supplies a Home-persisted credential root instead.
  const voiceSettingsV1 = VoiceSettingsPersistenceV1Schema.parse({
    ...settings.voice, credentialBindings: input.credentialBindings ?? [],
  });
  const { voice: _runtimeProjection, ...accountSettings } = settings;
  return settingsParse({ ...accountSettings, voiceSettingsV1 });
}

afterEach(() => {
  storage.setState(originalState, true);
  standardCleanup();
});

describe('VoiceSettingsScreen external provider credentials', () => {
  it('renders an installed provider declared account credential slot through the real settings route', async () => {
    await activateCredentialProvider();
    const account = await createVoiceSettingsAccountTestHarness(routeSettings({}));
    onTestFinished(account.dispose);
    const screen = await renderSettingsView(<InjectedAuthProvider credentials={account.credentials}><ModalProvider><VoiceConversationsSettingsScreen /></ModalProvider></InjectedAuthProvider>);
    await act(async () => undefined);

    const credential = screen.tree.findByType(VoiceCredentialItem);
    expect(credential.props).toMatchObject({
      testID: 'settings.voice.externalCredential.acme.voice%2Fconversation.api_key',
      contribution: { pluginId: 'acme.voice', localId: 'conversation' },
      credentialSlotId: 'api_key',
      disclosePlainStorage: true,
    });
    expect(credential.props).not.toHaveProperty('machineId');
  });

  it('reports ready only for the exact account binding and ignores the selected-daemon override', async () => {
    await activateCredentialProvider();
    const accountSecret = {
      id: 'account-secret',
      name: 'Account key',
      kind: 'apiKey',
      encryptedValue: { _isSecretValue: true, value: 'account-key' },
      createdAt: 1,
      updatedAt: 1,
    };
    const machineSecret = {
      ...accountSecret,
      id: 'machine-secret',
      name: 'Machine key',
      encryptedValue: { _isSecretValue: true, value: 'machine-key' },
    };
    const settings = routeSettings({
      secrets: [accountSecret, machineSecret],
      credentialBindings: [{
        contribution: { pluginId: 'acme.voice', localId: 'conversation' },
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'savedSecret' },
        credentialBindings: {
          account: { api_key: 'account-secret' },
          byMachineId: {
            'selected-daemon-that-must-not-own-client-credentials': { api_key: 'machine-secret' },
          },
        },
      }],
    });

    const account = await createVoiceSettingsAccountTestHarness(settings);
    onTestFinished(account.dispose);
    expect(account.settings.voiceSettingsV1.credentialBindings).toMatchObject([{
      contribution: { pluginId: 'acme.voice', localId: 'conversation' },
      credentialSlotId: 'api_key',
      credentialBindings: { account: { api_key: 'account-secret' } },
    }]);
    const screen = await renderSettingsView(<InjectedAuthProvider credentials={account.credentials}><ModalProvider><VoiceConversationsSettingsScreen /></ModalProvider></InjectedAuthProvider>);
    // Mounting the real picker admits the retained Settings secrets through the
    // catalog importer. Approval must use its current resource reference, not
    // the retired Settings id that the importer has already replaced.
    await act(async () => { await refreshSavedSecretCatalog(account.scope); });
    const accountResource = account.resources.find(resource => resource.entry.name === 'Account key');
    const machineResource = account.resources.find(resource => resource.entry.name === 'Machine key');
    if (!accountResource || !machineResource) throw new Error('Real SavedSecret catalog did not admit both input sources');
    expect(account.settings.voiceSettingsV1.credentialBindings).toMatchObject([{
      credentialBindings: {
        account: { api_key: accountResource.entry.ref },
        byMachineId: { 'selected-daemon-that-must-not-own-client-credentials': { api_key: machineResource.entry.ref } },
      },
    }]);
    const providerRowTestId = `settings.voice.provider.${encodeURIComponent(providerId)}.default`;
    // The credential state is the service tile's readiness line in the Service gallery.
    const serviceTileStatus = () => screen.findAll((node) => Array.isArray(node.props?.tiles))[0]
      ?.props.tiles.find((tile: { testID: string }) => tile.testID === providerRowTestId)?.status;
    // The tile's full prerequisite is its accessible detail; the visible text is a short status.
    const serviceStatus = () => { const status = serviceTileStatus(); return status?.detail ?? status?.text; };
    expect(serviceStatus()).toBe(t('settingsVoice.externalCredentials.reviewRequired'));
    const requiredDigest = screen.tree.findByType(VoiceCredentialItem).props.recipientContractDigest;
    if (typeof requiredDigest !== 'string') throw new Error('Activated provider recipient contract is unavailable');
    const approvedDigest = resolveAccountVoiceCredentialApprovalDigest({
      requiredRecipientContractDigest: requiredDigest,
      savedSecret: resolveSavedSecretReference(account.scope, account.settings.secrets, accountResource.entry.ref),
    });
    if (!approvedDigest) throw new Error('Admitted Account credential has no approvable fingerprint');
    await act(async () => {
      // The real row approves its already-bound credential before any enter-new gesture.
      screen.pressByTestId('settings.voice.externalCredential.acme.voice%2Fconversation.api_key');
    });
    await vi.waitFor(async () => {
      await act(async () => undefined);
      expect(screen.findHostByTestId('web-modal-confirm')).toBeTruthy();
    });
    expect(account.persistedSettings.voiceSettingsV1.credentialBindings[0]?.approvedRecipientContractDigest).not.toBe(approvedDigest);
    await screen.pressByTestIdAsync('web-modal-confirm');
    await act(async () => {
      await vi.waitFor(() => expect(account.persistedSettings.voiceSettingsV1.credentialBindings).toMatchObject([{
        approvedRecipientContractDigest: approvedDigest,
        credentialBindings: { account: { api_key: accountResource.entry.ref } },
      }]));
    });
    expect(serviceStatus()).toBe(t('settingsVoice.externalCredentials.ready'));

    const machineOnlySettings = routeSettings({
      secrets: [machineSecret],
      credentialBindings: [{
        contribution: { pluginId: 'acme.voice', localId: 'conversation' },
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'savedSecret' },
        approvedRecipientContractDigest: recipientContractDigest,
        credentialBindings: {
          byMachineId: {
            'selected-daemon-that-must-not-own-client-credentials': { api_key: 'machine-secret' },
          },
        },
      }],
    });
    await act(async () => {
      account.replaceSettings(machineOnlySettings);
    });

    expect(serviceStatus()).toContain(t('settingsVoice.externalCredentials.missing'));
    expect(serviceStatus()).toContain(tLoose('voice.readiness.credential_missing'));
    expect(screen.tree.findByType(VoiceCredentialItem).props)
      .not.toHaveProperty('machineId');
  });

});

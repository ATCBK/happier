import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  createRecipientContractDigestV1,
  VoiceProviderContributionSchema,
} from '@happier-dev/protocol';
import type {
  PluginSettingsActionDeclarationV2,
  VoiceProviderSettingsActionDeclaration,
} from '@happier-dev/protocol';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-elevenlabs/manifest';
import { createElevenLabsVoiceProviderRuntime } from '@happier-dev/plugins-elevenlabs/ui/voice';
import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } from '@happier-dev/plugins-elevenlabs/protocol/voice';

import { createAccountVoiceOperationService } from '@/voice/credentials/accountVoiceOperationService';
import { createBundledVoiceRecipientContract } from '@/voice/credentials/voiceRecipientContract';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { commitExternalVoiceProviderRegistration, removeExternalVoiceProviderRegistration, type ExternalVoiceProviderRegistration } from '@/voice/registry/externalVoiceProviderRegistrations';
import { createVoiceSettingsAccountTestHarness } from '../voiceSettingsAccountTestHarness';

let accountFixture: Awaited<ReturnType<typeof createVoiceSettingsAccountTestHarness>>;
let registration: ExternalVoiceProviderRegistration | null = null;
function replaceVoiceFixture(change: Partial<Settings['voice']>) {
  accountFixture.replaceVoice({ ...storage.getState().settings.voice, ...change });
}
function withProviderConfig(settings: Settings, config: Record<string, unknown>) {
  const voice = { ...settings.voice, providers: { ...settings.voice.providers,
    [PROVIDER_ID]: { schemaVersion: 2, config } } };
  return settingsParse({ ...settings, ...normalizeVoiceSettingsLocalDelta({ voice }, settings) });
}
const state = {
  get config() { return storage.getState().settings.voice.providers[PROVIDER_ID]?.config as Record<string, unknown>; },
  set config(config: Record<string, unknown>) {
    replaceVoiceFixture({ providers: { ...storage.getState().settings.voice.providers,
      [PROVIDER_ID]: { schemaVersion: state.schemaVersion, config: {
        ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS, ...config,
        tts: { ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts, ...(config.tts as object) },
      } } } });
  },
  get schemaVersion() { return storage.getState().settings.voice.providers[PROVIDER_ID]?.schemaVersion ?? 2; },
  set schemaVersion(schemaVersion: number) {
    replaceVoiceFixture({ providers: { ...storage.getState().settings.voice.providers,
      [PROVIDER_ID]: { schemaVersion, config: state.config } } });
  },
  get settingsVersion() { return storage.getState().settingsVersion ?? 1; },
  conflict: null as null | 'unrelated' | 'provider',
  mutationAttempts: 0,
  outcomeUnknown: false,
  mutationApplied: false,
  advanceDuringPreparation: false,
  get registration() { return registration; },
  set registration(next: ExternalVoiceProviderRegistration | null) {
    if (registration) removeExternalVoiceProviderRegistration(registration.token);
    registration = next;
    if (next) commitExternalVoiceProviderRegistration(next);
  },
  get selectedProviderId() { return storage.getState().settings.voice.providerId; },
  set selectedProviderId(providerId: string | null) { replaceVoiceFixture({ providerId }); },
  set accountSettings(value: Record<string, unknown> | null) {
    if (value) accountFixture.replaceSettings(settingsParse({ ...storage.getState().settings, ...value,
      voiceSettingsV1: { ...storage.getState().settings.voiceSettingsV1,
        ...(value.voiceSettingsV1 as Record<string, unknown> | undefined) } }));
  },
};
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
function mountActionView(element: React.ReactElement) {
  const tree = renderer.create(element);
  onTestFinished(async () => { await act(async () => { tree.unmount(); }); });
  return tree;
}

const PROVIDER_ID = vi.hoisted(() => 'happier.voice.elevenlabs/realtime-elevenlabs');

const spies = vi.hoisted(() => ({
  modalConfigs: [] as any[],
  show: vi.fn((config: any) => {
    spies.modalConfigs.push(config);
    return `modal-${spies.modalConfigs.length}`;
  }),
  hide: vi.fn(),
  alertAsync: vi.fn(async () => undefined),
  execute: vi.fn(async () => ({ patch: { agentId: 'agent-created' } })),
  log: vi.fn(),
}));


vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
  spies: { show: spies.show, hide: spies.hide, alertAsync: spies.alertAsync },
}).module);
vi.mock('@/log', () => ({ log: { log: spies.log } }));
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({
    // Render params inline so an assertion can see the exact facts a copy key
    // was given without depending on the English wording around them.
    translate: (key: string, params?: Record<string, unknown>) => (
      params ? `${key}(${JSON.stringify(params)})` : key
    ),
  });
});

const action: PluginSettingsActionDeclarationV2 = {
  id: 'create-agent',
  title: 'Create agent',
  placement: { kind: 'afterField', fieldId: 'agentId' },
  confirmation: {
    kind: 'required',
    title: 'Create?',
    description: 'Creates the agent.',
    confirmLabel: 'Create',
  },
  patchFieldIds: ['agentId'],
};

const conditionalUpdateAction: VoiceProviderSettingsActionDeclaration = {
  ...action,
  id: 'update-agent',
  title: 'Update agent',
  enabledWhen: { kind: 'setting_nonempty', settingId: 'agentId' },
};

const owner = {
  schemaVersion: 2,
  defaultConfig: { ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS, billingMode: 'byo', agentId: '' },
  parseConfig(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.agentId === 'string' ? candidate : null;
  },
};

describe('VoiceProviderSettingsActions', () => {
  it('offers one inline operation chosen from the contributed agent state', async () => {
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    const contribution = VoiceProviderContributionSchema.parse(PLUGIN_MANIFEST.contributes.voiceProviders?.[0]);
    const actions = contribution.settings?.actions ?? [];
    const agentAction = { settingId: 'agentId', createActionId: 'create-agent', updateActionId: 'update-agent',
      titleKey: 'agent', missingStateKey: 'missing', configuredStateKey: 'configured' };
    let tree!: renderer.ReactTestRenderer;
    const render = (agentId: string) => <VoiceProviderSettingsActions providerId={PROVIDER_ID} owner={owner}
      actions={actions} config={{ ...state.config, agentId }} agentAction={agentAction}
      placement={{ kind: 'afterField', fieldId: 'agentId' }} />;
    await act(async () => { tree = mountActionView(render('')); });
    const buttons = () => [...new Set(tree.root.findAll((node) => typeof node.props.testID === 'string'
      && node.props.testID.startsWith('voice-settings-action-')).map((node) => node.props.testID))];
    expect(buttons()).toEqual(['voice-settings-action-create-agent']);
    await act(async () => { tree.update(render('existing-agent')); });
    expect(buttons()).toEqual(['voice-settings-action-update-agent']);
    await act(async () => { tree.unmount(); });
  });
  beforeEach(async () => {
    accountFixture = await createVoiceSettingsAccountTestHarness(settingsParse({
      voice: { providerId: PROVIDER_ID, providers: { [PROVIDER_ID]: {
        schemaVersion: 2, config: { ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS, billingMode: 'byo', agentId: '' },
      } } },
    }));
    onTestFinished(async () => { state.registration = null; await accountFixture.dispose(); });
    accountFixture.replaceSettings(storage.getState().settings, { version: 4 });
    const request = accountFixture.request.getMockImplementation()!;
    accountFixture.request.mockImplementation(async (url, init) => {
      if (new URL(url).pathname === '/v2/account/settings') {
        if (state.advanceDuringPreparation) {
          state.advanceDuringPreparation = false;
          accountFixture.replaceSettings(withProviderConfig(storage.getState().settings,
            { ...state.config, billingMode: 'happier' }), { version: 5, publish: false });
        }
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body));
          if (body.content?.t === 'plain' && body.content.v?.voiceSettingsV1?.providers?.[PROVIDER_ID]?.config?.agentId === 'agent-created') {
            state.mutationAttempts += 1;
          }
          if (state.conflict) {
            const providerChanged = state.conflict === 'provider';
            state.conflict = null;
            const current = storage.getState().settings;
            accountFixture.replaceSettings(providerChanged
              ? withProviderConfig(current, { ...state.config, billingMode: 'happier' })
              : settingsParse({ ...current, analyticsOptOut: !current.analyticsOptOut }),
              { version: state.settingsVersion + 1, publish: false });
          }
          if (state.outcomeUnknown) throw new Error('transport_response_lost');
          const result = await request(url, init);
          state.mutationApplied = result.ok && (await result.clone().json()).success === true;
          return result;
        }
        if (state.outcomeUnknown && state.mutationAttempts > 0) throw new Error('transport_read_unavailable');
      }
      return request(url, init);
    });
    state.config = { billingMode: 'byo', agentId: '', tts: {} };
    state.schemaVersion = 2;
    state.conflict = null;
    state.mutationAttempts = 0;
    state.outcomeUnknown = false;
    state.mutationApplied = false;
    state.advanceDuringPreparation = false;
    state.selectedProviderId = PROVIDER_ID;
    state.accountSettings = null;
    spies.modalConfigs.length = 0;
    spies.show.mockClear();
    spies.hide.mockClear();
    spies.alertAsync.mockClear();
    spies.execute.mockClear();
    spies.log.mockClear();
    state.registration = Object.freeze({
      token: Object.freeze({}),
      pluginId: 'happier.voice.elevenlabs',
      localId: 'realtime-elevenlabs',
      providerId: PROVIDER_ID,
      descriptor: null,
      adapter: null,
      occurrenceId: 'voice-occurrence-a',
      settingsActions: Object.freeze({ execute: spies.execute }),
    });
  });

  it('admits an agent-requested operation only after real confirmation and reports the applied patch', async () => {
    const { invokeVoiceProviderSettingsAction } = await import('@/voice/settings/voiceProviderSettingsActionInvoker');
    const pending = invokeVoiceProviderSettingsAction({ providerId: PROVIDER_ID, owner, declaration: action });
    await vi.waitFor(() => expect(spies.modalConfigs).toHaveLength(1));
    expect(state.mutationApplied).toBe(false);
    expect(spies.execute).not.toHaveBeenCalled();
    spies.modalConfigs[0].props.onConfirm();
    expect(await pending).toEqual({ status: 'completed' });
    expect(state.config.agentId).toBe('agent-created');
  });

  it('leaves the provider and settings untouched when the human declines an agent operation', async () => {
    const { invokeVoiceProviderSettingsAction } = await import('@/voice/settings/voiceProviderSettingsActionInvoker');
    const pending = invokeVoiceProviderSettingsAction({ providerId: PROVIDER_ID, owner, declaration: action });
    await vi.waitFor(() => expect(spies.modalConfigs).toHaveLength(1));
    spies.modalConfigs[0].props.onCancel();
    expect(await pending).toMatchObject({ status: 'cancelled' });
    expect(state.mutationApplied).toBe(false);
    expect(spies.execute).not.toHaveBeenCalled();
  });

  it('does not expose plugin-supplied failure text through an operation result', async () => {
    spies.execute.mockRejectedValueOnce({ code: 'private_provider_payload', message: 'private_provider_payload' });
    const { invokeVoiceProviderSettingsAction } = await import('@/voice/settings/voiceProviderSettingsActionInvoker');
    const pending = invokeVoiceProviderSettingsAction({ providerId: PROVIDER_ID, owner, declaration: action });
    await vi.waitFor(() => expect(spies.modalConfigs).toHaveLength(1));
    spies.modalConfigs[0].props.onConfirm();
    expect(await pending).toEqual({ status: 'unavailable', reason: 'internal_error' });
    expect(state.mutationApplied).toBe(false);
  });

  it('retains a future provider envelope instead of invoking against defaults', async () => {
    state.schemaVersion = 99;
    const original = state.config;
    const { invokeVoiceProviderSettingsAction } = await import('@/voice/settings/voiceProviderSettingsActionInvoker');
    const pending = invokeVoiceProviderSettingsAction({ providerId: PROVIDER_ID, owner, declaration: action });
    await vi.waitFor(() => expect(spies.modalConfigs).toHaveLength(1));
    spies.modalConfigs[0].props.onConfirm();
    expect(await pending).toMatchObject({ status: 'unavailable', reason: 'voice_provider_settings_invalid' });
    expect(state.config).toBe(original);
    expect(state.mutationApplied).toBe(false);
    expect(spies.execute).not.toHaveBeenCalled();
  });

  it('retires the captured Action Account before confirmation can invoke a new current Account', async () => {
    let current = true;
    const { invokeVoiceProviderSettingsAction } = await import('@/voice/settings/voiceProviderSettingsActionInvoker');
    const pending = invokeVoiceProviderSettingsAction({ providerId: PROVIDER_ID, owner, declaration: action, isCurrent: () => current });
    await vi.waitFor(() => expect(spies.modalConfigs).toHaveLength(1));
    current = false;
    spies.modalConfigs[0].props.onConfirm();
    expect(await pending).toMatchObject({ status: 'unavailable' });
    expect(state.mutationApplied).toBe(false);
    expect(spies.execute).not.toHaveBeenCalled();
  });

  it('retires the old producer confirmation and admits a fresh confirmation after occurrence replacement', async () => {
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    const props = {
      providerId: PROVIDER_ID,
      owner,
      actions: [action],
      placement: { kind: 'afterField' as const, fieldId: 'agentId' },
    };
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = mountActionView(<VoiceProviderSettingsActions {...props} />);
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
      await vi.waitFor(() => expect(spies.modalConfigs).toHaveLength(1));
    });

    state.registration = Object.freeze({
      ...state.registration,
      token: Object.freeze({}),
      occurrenceId: 'voice-occurrence-b',
    });
    await act(async () => {
      tree.update(<VoiceProviderSettingsActions {...props} />);
    });
    await act(async () => {
      await vi.waitFor(() => expect(tree.root.findByProps({
        testID: 'voice-settings-action-create-agent',
      }).props.loading).toBe(false));
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
      await vi.waitFor(() => expect(spies.modalConfigs).toHaveLength(2));
    });
    await act(async () => {
      spies.modalConfigs[0].props.onConfirm();
    });
    expect(spies.execute).not.toHaveBeenCalled();
    await act(async () => {
      spies.modalConfigs[1].props.onConfirm();
      await vi.waitFor(() => expect(state.config.agentId).toBe('agent-created'));
    });
    await act(async () => {
      tree.unmount();
    });
  });

  it('fails closed when a settings-action registration has no producer occurrence', async () => {
    // Malformed external plugin registration exercises the host's runtime admission guard.
    state.registration = Object.freeze({
      ...state.registration,
      occurrenceId: undefined,
    }) as ExternalVoiceProviderRegistration;
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[action]}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });
    expect(tree.toJSON()).toBeNull();
  });

  it('enables a declared nonempty action only after its setting has a value', async () => {
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[conditionalUpdateAction]}
        config={state.config}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });
    const disabledRow = tree.root.findByProps({ testID: 'voice-settings-action-update-agent' });
    expect(disabledRow.props.disabled).toBe(true);
    disabledRow.props.onPress();
    expect(spies.show).not.toHaveBeenCalled();

    const configured = { ...state.config, agentId: 'agent-existing' };
    await act(async () => {
      tree.update(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[conditionalUpdateAction]}
        config={configured}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });
    expect(tree.root.findByProps({
      testID: 'voice-settings-action-update-agent',
    }).props.disabled).toBe(false);
  });

  it('renders from the declaration and applies the bounded patch through one-shot Account Settings CAS', async () => {
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[action]}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });
    const row = tree.root.findByProps({ testID: 'voice-settings-action-create-agent' });
    expect(row.props.title).toBe('Create agent');
    await act(async () => {
      row.props.onPress();
      await vi.waitFor(() => expect(spies.modalConfigs).toHaveLength(1));
      spies.modalConfigs[0].props.onConfirm();
      await vi.waitFor(() => expect(state.mutationApplied).toBe(true));
    });
    expect(spies.modalConfigs[0]).toMatchObject({
      props: { description: 'Creates the agent.', confirmLabel: 'Create' },
      chrome: { title: 'Create?', testID: 'app-shell-transient-interaction-dialog' },
    });
    expect(spies.execute).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'create-agent',
      settings: expect.objectContaining({ agentId: '' }),
      settingsRevision: '4',
      signal: expect.any(AbortSignal),
    }));
    expect(state.config.agentId).toBe('agent-created');
  });

  it('pairs action values with the same canonical revision when settings advance during preparation', async () => {
    state.advanceDuringPreparation = true;
    const { sync } = await import('@/sync/sync');
    sync.applySettings({ analyticsOptOut: true }, { expectedSettingsScope: accountFixture.scope });
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[action]}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
      await vi.waitFor(() => expect(spies.modalConfigs).toHaveLength(1));
      spies.modalConfigs[0].props.onConfirm();
      await vi.waitFor(() => expect(state.mutationApplied).toBe(true));
    });

    expect(spies.execute).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({ billingMode: 'happier' }),
      settingsRevision: '5',
    }));
    expect(state.mutationAttempts).toBe(1);
  });

  it('reconciles once when a CAS conflict changed no provider config read by the action', async () => {
    state.conflict = 'unrelated';
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[action]}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
      await vi.waitFor(() => expect(spies.modalConfigs).toHaveLength(1));
      spies.modalConfigs[0].props.onConfirm();
      await vi.waitFor(() => expect(state.mutationApplied).toBe(true));
    });
    expect(state.mutationAttempts).toBe(2);
    expect(state.config.agentId).toBe('agent-created');
    expect(spies.alertAsync).not.toHaveBeenCalled();
  });

  it('does not merge after a CAS conflict changed provider config read by the action', async () => {
    state.conflict = 'provider';
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[action]}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
      await vi.waitFor(() => expect(spies.modalConfigs).toHaveLength(1));
      spies.modalConfigs[0].props.onConfirm();
      await vi.waitFor(() => expect(spies.alertAsync).toHaveBeenCalled());
    });
    expect(state.mutationApplied).toBe(false);
    expect(state.config.agentId).toBe('');
    expect(state.config.billingMode).toBe('happier');
    expect(state.mutationAttempts).toBe(1);
    expect(spies.alertAsync).toHaveBeenCalledWith(
      'common.error',
      'settingsProviders.errors.mutationOutcomeUnknownDescription',
    );
  });

  it('surfaces an ambiguous Account Settings action patch without claiming it applied', async () => {
    state.outcomeUnknown = true;
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[action]}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });

    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
      await vi.waitFor(() => expect(spies.modalConfigs).toHaveLength(1));
      spies.modalConfigs[0].props.onConfirm();
      await vi.waitFor(() => expect(spies.alertAsync).toHaveBeenCalledWith(
        'common.error',
        'settingsProviders.errors.mutationOutcomeUnknownDescription',
      ));
    });

    expect(state.mutationApplied).toBe(false);
    expect(state.config.agentId).toBe('');
    expect(spies.log).toHaveBeenCalledWith(
      '[VoiceProviderSettingsActions] settings action failed {"actionId":"create-agent","code":"voice_provider_settings_action_outcome_unknown"}',
    );
  });

  it('surfaces the failing stage and status while stripping provider prose from the log and the alert', async () => {
    spies.execute.mockRejectedValueOnce(Object.assign(
      new Error('private provider response containing secret material'),
      {
        code: 'provider_response_invalid',
        stage: 'update_agent',
        responseFailure: {
          kind: 'http_status',
          status: 422,
          statusClass: '4xx',
          // A plugin may still attach arbitrary provider text. The host
          // projection is an allowlist, so none of this may survive.
          providerDetail: 'HAPPIER_PROVIDER_PROSE_SENTINEL tool ids must be owned by this workspace',
          body: 'private provider response',
          headers: { authorization: 'secret credential' },
          url: 'https://provider.example/agents/private-agent-id',
        },
        parameters: { agentId: 'private-agent-id' },
        settings: { apiKey: 'secret credential' },
      },
    ));
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[action]}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });

    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
      await vi.waitFor(() => expect(spies.modalConfigs).toHaveLength(1));
      spies.modalConfigs[0].props.onConfirm();
      await vi.waitFor(() => expect(spies.alertAsync).toHaveBeenCalled());
    });

    expect(spies.log.mock.calls.filter(([message]) => message.startsWith('[VoiceProviderSettingsActions]'))).toHaveLength(1);
    expect(spies.log).toHaveBeenCalledWith(
      '[VoiceProviderSettingsActions] settings action failed {"actionId":"create-agent","code":"provider_response_invalid","stage":"update_agent","responseFailure":{"kind":"http_status","status":422,"statusClass":"4xx"}}',
    );
    // The press is still actionable: the alert names the failing step and the
    // provider status without repeating a single character of provider prose.
    expect(spies.alertAsync).toHaveBeenCalledWith(
      'common.error',
      'settingsVoice.realtimeProviders.operationFailedUnsaved'
        + '\n\nsettingsVoice.realtimeProviders.operationFailedStage({"stage":"update_agent"})'
        + '\nsettingsVoice.realtimeProviders.operationFailedStatus({"status":422})',
    );
    const surfaced = JSON.stringify([spies.log.mock.calls, spies.alertAsync.mock.calls]);
    expect(surfaced).not.toContain('HAPPIER_PROVIDER_PROSE_SENTINEL');
    expect(surfaced).not.toContain('secret credential');
    expect(surfaced).not.toContain('private-agent-id');
  });

  it('composes the final ElevenLabs Agent PATCH HTTP failure into a safe actionable diagnostic without applying settings', async () => {
    const parsedDeclaration = VoiceProviderContributionSchema.safeParse(
      (PLUGIN_MANIFEST.contributes.voiceProviders ?? [])[0],
    );
    if (
      !parsedDeclaration.success
      || parsedDeclaration.data.kind !== 'conversation'
      || !parsedDeclaration.data.credentials?.hostMediated
    ) {
      throw new Error('elevenlabs_host_mediated_contract_missing');
    }
    const declaration = parsedDeclaration.data;
    const recipientContract = createBundledVoiceRecipientContract({
      pluginId: PLUGIN_MANIFEST.id,
      declaration,
    });
    if (!recipientContract) throw new Error('elevenlabs_recipient_contract_missing');
    const contribution = Object.freeze({
      pluginId: PLUGIN_MANIFEST.id,
      localId: declaration.id,
    });
    const runtime = createElevenLabsVoiceProviderRuntime();
    const runtimeActions = runtime.settingsActions;
    const providerProse = 'HAPPIER_PROVIDER_PROSE_SENTINEL agent configuration is private';
    const failureResponse = new Response(providerProse, { status: 400 });
    const responseBody = failureResponse.body;
    if (!responseBody) throw new Error('elevenlabs_failure_body_missing');
    const responseConsumers = [
      vi.spyOn(responseBody, 'getReader'),
      vi.spyOn(failureResponse, 'text'),
      vi.spyOn(failureResponse, 'json'),
      vi.spyOn(failureResponse, 'arrayBuffer'),
    ];
    const cancelBody = vi.spyOn(responseBody, 'cancel');
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const request = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (request.pathname === '/v1/voices') {
        return new Response(JSON.stringify({
          voices: [{ voice_id: 'hpp4J3VqNfWAUOO0d1Us', name: 'Default Happier Voice' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (request.pathname === '/v1/convai/tools' && init?.method === 'GET') {
        return new Response(JSON.stringify({ tools: [], has_more: false, next_cursor: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (request.pathname === '/v1/convai/tools' && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: `tool-${fetch.mock.calls.length}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (request.pathname === '/v1/convai/agents/agent-existing') {
        if (init?.method === 'GET') {
          return new Response(JSON.stringify({
            agent_id: 'agent-existing',
            conversation_config: { agent: { prompt: { tool_ids: [] } } },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        expect(init?.method).toBe('PATCH');
        return failureResponse;
      }
      throw new Error(`unexpected_elevenlabs_operation:${request.pathname}`);
    });
    state.config = {
      billingMode: 'byo',
      agentId: 'agent-existing',
      tts: {
        voiceId: 'hpp4J3VqNfWAUOO0d1Us',
        modelId: null,
        voiceSettings: { stability: null, similarityBoost: null, speed: null },
      },
    };
    state.accountSettings = {
      voiceSettingsV1: {
        credentialBindings: [{
          contribution,
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'savedSecret' },
          credentialBindings: { account: { api_key: 'elevenlabs-secret' } },
          approvedRecipientContractDigest: createRecipientContractDigestV1(recipientContract),
        }],
      },
      secrets: [{
        id: 'elevenlabs-secret',
        name: 'ElevenLabs API key',
        kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, value: 'not-materialized-in-this-test' },
        createdAt: 1,
        updatedAt: 1,
      }],
    };
    state.registration = Object.freeze({
      token: Object.freeze({}),
      pluginId: PLUGIN_MANIFEST.id,
      localId: declaration.id,
      providerId: PROVIDER_ID,
      occurrenceId: 'voice-occurrence-composed',
      descriptor: null,
      adapter: null,
      settingsActions: Object.freeze({
        async execute(input: Parameters<typeof runtimeActions.execute>[0] & Readonly<{
          signal: AbortSignal;
        }>) {
          const accountOperations = createAccountVoiceOperationService({
            providerId: PROVIDER_ID,
            contribution,
            declaration,
            phase: 'settings',
            recipientContract,
            signal: input.signal,
            isCurrent: () => true,
            fetch,
          });
          return await runtimeActions.execute(input, {
            credentials: { phase: 'settings', mediated: accountOperations, raw: null },
            interactions: { askQuestions: vi.fn() },
            signal: input.signal,
            tools: [],
          });
        },
      }),
    });

    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[conditionalUpdateAction]}
        config={state.config}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-update-agent' }).props.onPress();
      await vi.waitFor(() => expect(spies.modalConfigs).toHaveLength(1));
      spies.modalConfigs[0].props.onConfirm();
      await vi.waitFor(() => expect(spies.alertAsync).toHaveBeenCalled());
    });

    expect(spies.log).toHaveBeenCalledWith(
      '[VoiceProviderSettingsActions] settings action failed'
      + ' {"actionId":"update-agent","code":"provider_response_invalid","stage":"update_agent"'
      + ',"responseFailure":{"kind":"http_status","status":400,"statusClass":"4xx"}}',
    );
    const providerMutations = fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(providerMutations).toHaveLength(1);
    expect(state.mutationApplied).toBe(false);
    expect(state.config.agentId).toBe('agent-existing');
    for (const consume of responseConsumers) expect(consume).not.toHaveBeenCalled();
    expect(cancelBody).toHaveBeenCalledOnce();
    expect(spies.alertAsync).toHaveBeenCalledWith(
      'common.error',
      'settingsVoice.realtimeProviders.operationFailedUnsaved'
        + '\n\nsettingsVoice.realtimeProviders.operationFailedStage({"stage":"update_agent"})'
        + '\nsettingsVoice.realtimeProviders.operationFailedStatus({"status":400})',
    );
    const surfaced = JSON.stringify([spies.log.mock.calls, spies.alertAsync.mock.calls]);
    expect(surfaced).not.toContain('HAPPIER_PROVIDER_PROSE_SENTINEL');
    expect(surfaced).not.toContain('elevenlabs-secret');
    expect(surfaced).not.toContain('agent-existing');
  });

  it('tells the user which setting to fix when the provider reports a typed unusable-voice code', async () => {
    spies.execute.mockRejectedValueOnce(Object.assign(
      new Error('voice_not_found'),
      {
        code: 'voice_not_found',
        stage: 'validate_voice',
        // A plugin may still attach the provider's own prose alongside the
        // typed code. Only the code is structural, so only the code survives.
        providerDetail: 'HAPPIER_PROVIDER_PROSE_SENTINEL A voice for the voice_id was not found.',
        requestId: 'private-request-id',
      },
    ));
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[action]}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });

    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
      await vi.waitFor(() => expect(spies.modalConfigs).toHaveLength(1));
      spies.modalConfigs[0].props.onConfirm();
      await vi.waitFor(() => expect(spies.alertAsync).toHaveBeenCalled());
    });

    expect(state.mutationApplied).toBe(false);
    // The remedy replaces the generic "changes were not saved" headline: the
    // user is told the selected voice is the thing to change.
    expect(spies.alertAsync).toHaveBeenCalledWith(
      'common.error',
      'settingsVoice.realtimeProviders.operationFailedVoiceNotFound'
        + '\n\nsettingsVoice.realtimeProviders.operationFailedStage({"stage":"validate_voice"})',
    );
    expect(spies.log).toHaveBeenCalledWith(
      '[VoiceProviderSettingsActions] settings action failed'
      + ' {"actionId":"create-agent","code":"voice_not_found","stage":"validate_voice"}',
    );
    const surfaced = JSON.stringify([spies.log.mock.calls, spies.alertAsync.mock.calls]);
    expect(surfaced).not.toContain('HAPPIER_PROVIDER_PROSE_SENTINEL');
    expect(surfaced).not.toContain('private-request-id');
  });

  it('quietly clears busy state without CAS mutation when the user cancels an interaction', async () => {
    spies.execute.mockRejectedValueOnce(Object.assign(
      new Error('plugin_settings_action_cancelled'),
      { code: 'plugin_settings_action_cancelled' },
    ));
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[action]}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
      await vi.waitFor(() => expect(spies.modalConfigs).toHaveLength(1));
      spies.modalConfigs[0].props.onConfirm();
      await vi.waitFor(() => {
        expect(tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.loading).toBe(false);
      });
    });
    expect(state.mutationApplied).toBe(false);
    expect(spies.alertAsync).not.toHaveBeenCalled();
  });

  it('names a confirmation that could not be presented instead of doing nothing', async () => {
    spies.show.mockImplementationOnce(() => '');
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[action]}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
      await vi.waitFor(() => expect(spies.alertAsync).toHaveBeenCalled());
    });
    expect(spies.execute).not.toHaveBeenCalled();
    expect(state.mutationApplied).toBe(false);
    expect(spies.log.mock.calls.filter(([message]) => message.startsWith('[VoiceProviderSettingsActions]'))).toHaveLength(1);
    expect(spies.log).toHaveBeenCalledWith(
      '[VoiceProviderSettingsActions] settings action failed'
      + ' {"actionId":"create-agent","code":"voice_provider_settings_action_confirmation_unavailable"}',
    );
    expect(tree.root.findByProps({
      testID: 'voice-settings-action-create-agent',
    }).props.loading).toBe(false);
  });

  it('names a generation retired under a still-mounted panel and frees the action again', async () => {
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[action]}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
      await vi.waitFor(() => expect(spies.modalConfigs).toHaveLength(1));
    });
    // The activation scope re-commits the provider registration while the
    // panel stays mounted: the press is retired without any lifecycle abort.
    state.registration = Object.freeze({
      token: Object.freeze({}),
      pluginId: 'happier.voice.elevenlabs',
      localId: 'realtime-elevenlabs',
      providerId: PROVIDER_ID,
      occurrenceId: 'voice-occurrence-b',
      settingsActions: Object.freeze({ execute: spies.execute }),
    });
    await act(async () => {
      spies.modalConfigs[0].props.onConfirm();
      await vi.waitFor(() => expect(spies.alertAsync).toHaveBeenCalled());
    });
    expect(spies.execute).not.toHaveBeenCalled();
    expect(state.mutationApplied).toBe(false);
    expect(spies.log.mock.calls.filter(([message]) => message.startsWith('[VoiceProviderSettingsActions]'))).toHaveLength(1);
    expect(spies.log).toHaveBeenCalledWith(
      '[VoiceProviderSettingsActions] settings action failed'
      + ' {"actionId":"create-agent","retired":true,"code":"plugin_settings_action_generation_retired"}',
    );
    expect(tree.root.findByProps({
      testID: 'voice-settings-action-create-agent',
    }).props.loading).toBe(false);
  });

  it('stays quiet but nameable when the user selects another provider mid-press', async () => {
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[action]}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
      await vi.waitFor(() => expect(spies.modalConfigs).toHaveLength(1));
    });
    state.selectedProviderId = 'happier.voice.openai/realtime-openai';
    await act(async () => {
      spies.modalConfigs[0].props.onConfirm();
      await vi.waitFor(() => expect(spies.log).toHaveBeenCalled());
    });
    expect(spies.alertAsync).not.toHaveBeenCalled();
    expect(state.mutationApplied).toBe(false);
    expect(spies.log).toHaveBeenCalledWith(
      '[VoiceProviderSettingsActions] settings action deselected'
      + ' {"actionId":"create-agent","retired":true,"code":"plugin_settings_action_generation_retired"}',
    );
  });

  it('retires and dismisses a pending confirmation before execute/CAS, then admits its replacement', async () => {
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    const props = {
      providerId: PROVIDER_ID,
      owner,
      actions: [action],
      placement: { kind: 'afterField' as const, fieldId: 'agentId' },
    };
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = mountActionView(<VoiceProviderSettingsActions {...props} />);
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
      await vi.waitFor(() => expect(spies.modalConfigs).toHaveLength(1));
    });

    state.registration = Object.freeze({
      token: Object.freeze({}),
      pluginId: 'happier.voice.elevenlabs',
      localId: 'realtime-elevenlabs',
      providerId: PROVIDER_ID,
      occurrenceId: 'voice-occurrence-b',
      settingsActions: Object.freeze({ execute: spies.execute }),
    });
    await act(async () => {
      tree.update(<VoiceProviderSettingsActions {...props} />);
    });
    expect(spies.hide).toHaveBeenCalledWith('modal-1');
    expect(spies.execute).not.toHaveBeenCalled();
    expect(state.mutationApplied).toBe(false);

    await act(async () => {
      await vi.waitFor(() => expect(tree.root.findByProps({
        testID: 'voice-settings-action-create-agent',
      }).props.loading).toBe(false));
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
      await vi.waitFor(() => expect(spies.modalConfigs).toHaveLength(2));
      spies.modalConfigs[1].props.onConfirm();
      await vi.waitFor(() => expect(state.mutationApplied).toBe(true));
    });
    expect(spies.execute).toHaveBeenCalledTimes(1);
  });

  it('dismisses a pending confirmation on unmount without execute/CAS', async () => {
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[action]}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
      await vi.waitFor(() => expect(spies.modalConfigs).toHaveLength(1));
      tree.unmount();
    });
    expect(spies.hide).toHaveBeenCalledWith('modal-1');
    expect(spies.execute).not.toHaveBeenCalled();
    expect(state.mutationApplied).toBe(false);
  });

  it('allows a remounted action lifecycle to replace an abort-ignoring invocation under the same registration token', async () => {
    let resolveStale!: (value: Readonly<{ patch: Readonly<{ agentId: string }> }>) => void;
    let resolveReplacement!: (value: Readonly<{ patch: Readonly<{ agentId: string }> }>) => void;
    const staleResult = new Promise<Readonly<{ patch: Readonly<{ agentId: string }> }>>((resolve) => {
      resolveStale = resolve;
    });
    const replacementResult = new Promise<Readonly<{ patch: Readonly<{ agentId: string }> }>>((resolve) => {
      resolveReplacement = resolve;
    });
    spies.execute
      .mockImplementationOnce(async () => await staleResult)
      .mockImplementationOnce(async () => await replacementResult);
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    const props = {
      providerId: PROVIDER_ID,
      owner,
      actions: [action],
      placement: { kind: 'afterField' as const, fieldId: 'agentId' },
    };
    let staleTree!: renderer.ReactTestRenderer;
    await act(async () => {
      staleTree = mountActionView(<VoiceProviderSettingsActions {...props} />);
    });
    await act(async () => {
      staleTree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
      await vi.waitFor(() => expect(spies.modalConfigs).toHaveLength(1));
      spies.modalConfigs[0].props.onConfirm();
      await vi.waitFor(() => expect(spies.execute).toHaveBeenCalledTimes(1));
    });
    await act(async () => {
      staleTree.unmount();
    });

    let replacementTree!: renderer.ReactTestRenderer;
    await act(async () => {
      replacementTree = mountActionView(<VoiceProviderSettingsActions {...props} />);
    });
    await act(async () => {
      replacementTree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
      await vi.waitFor(() => expect(spies.modalConfigs).toHaveLength(2));
      spies.modalConfigs[1].props.onConfirm();
      await vi.waitFor(() => expect(spies.execute).toHaveBeenCalledTimes(2));
    });

    resolveReplacement({ patch: { agentId: 'replacement-agent' } });
    await act(async () => {
      await vi.waitFor(() => expect(state.config.agentId).toBe('replacement-agent'));
    });
    resolveStale({ patch: { agentId: 'stale-agent' } });
    await act(async () => {
      await Promise.resolve();
    });
    expect(state.config.agentId).toBe('replacement-agent');
    expect(spies.alertAsync).not.toHaveBeenCalled();
  });
});

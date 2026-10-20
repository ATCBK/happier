/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createRecipientContractDigestV1, normalizeRecipientContractV1, VoiceProviderContributionSchema } from '@happier-dev/protocol';
import type { ConnectedPurposeCatalogV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { Settings } from '@/sync/domains/settings/settings';
import type { AlertButton } from 'react-native';

const boundary = vi.hoisted(() => ({
  confirm: vi.fn<(title: string, message?: string) => void>(),
  alert: vi.fn<(title: string, message?: string) => void>(),
  nativeAlert: vi.fn<(title: string, message?: string, buttons?: AlertButton[]) => void>(),
  confirmDecisions: [] as boolean[],
}));
installDisconnectedServerSocketBoundary();
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock(
  { platformOS: 'ios' }, { Alert: { alert: boundary.nativeAlert } },
));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@more-tech/react-native-libsodium', () => import('libsodium-wrappers'));
vi.mock('@/platform/cryptoRandom', () => import('@/platform/cryptoRandom.node'));
vi.mock('@/platform/digest', () => import('@/platform/digest.node'));
vi.mock('@/platform/hmacSha512', () => import('@/platform/hmacSha512.node'));
vi.mock('@/platform/randomUUID', () => import('@/platform/randomUUID.node'));

await loadSyncSingletonForTests();
const { createSecretSettingsTestHarness } = await import('@/components/settings/secrets/secretSettingsTestHarness');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { t } = await import('@/text');
const { log } = await import('@/log');
const recipientContract = normalizeRecipientContractV1({
  version: 1,
  package: {
    pluginId: 'com.acme.voice',
    source: { kind: 'package', locator: '@acme/voice' },
  },
  publisher: {
    trust: 'verified',
    identity: 'npm:https://registry.npmjs.org:@acme',
  },
  contribution: {
    pluginId: 'com.acme.voice',
    localId: 'conversation',
  },
  credentialSlot: {
    id: 'api-key',
    scope: 'account',
  },
  operations: [
    {
      id: 'z-catalog',
      purpose: 'voice.catalog',
      credentialSlotId: 'api-key',
      effect: 'read',
      request: {
        origin: 'https://catalog.example.com',
        pathTemplate: '/v1/voices',
        queryTemplate: [{ name: 'internal-mode', value: 'DO_NOT_SHOW_STATIC' }],
        headerTemplate: [{ name: 'x-static', value: 'DO_NOT_SHOW_HEADER' }],
        bodyTemplate: { kind: 'none' },
        method: 'GET',
        credential: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' },
        redirect: 'error',
        maxBodyBytes: 0,
        contentTypes: [],
      },
      parameters: {
        schema: { type: 'object', properties: {}, additionalProperties: false },
        mapping: [],
      },
      response: {
        maxBytes: 32_768,
        contentTypes: ['application/json'],
      },
    },
    {
      id: 'a-create',
      purpose: 'voice.session-create',
      credentialSlotId: 'api-key',
      effect: 'mutation',
      request: {
        origin: 'https://api.example.com',
        pathTemplate: '/v1/sessions',
        queryTemplate: [],
        headerTemplate: [],
        bodyTemplate: { kind: 'json', value: { internal: 'DO_NOT_SHOW_BODY' } },
        method: 'POST',
        credential: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
        redirect: 'error',
        maxBodyBytes: 4_096,
        contentTypes: ['application/json'],
      },
      parameters: {
        schema: { type: 'object', properties: {}, additionalProperties: false },
        mapping: [],
      },
      response: {
        maxBytes: 65_536,
        contentTypes: ['application/json'],
      },
    },
  ],
  presentation: { title: 'Acme Voice' },
});

const credentialSourceDeclaration = VoiceProviderContributionSchema.parse({
  id: 'conversation',
  title: 'Acme Voice',
  kind: 'conversation',
  roles: ['realtime_conversation'],
  platforms: ['web'],
  capabilities: { turn: { cancelResponse: false, bargeIn: false } },
  credentials: {
    slot: { id: 'api-key', purpose: 'voice.client-auth', title: 'API key' },
    requirement: { kind: 'always' },
    sources: [{
      kind: 'savedSecret',
      secretKinds: ['apiKey'],
      rawGrants: [{
        realm: 'web',
        phase: 'prepare',
        request: {
          kind: 'httpHeaders',
          origin: 'https://api.example.com',
          headerNames: ['authorization'],
        },
      }],
    }],
  },
  client: {
    artifactId: 'web-runtime',
    exportName: 'activate',
  },
});


const { createVoiceProviderRegistry } = await import('@/voice/registry/providerRegistry');
const { commitExternalVoiceProviderRegistration, removeExternalVoiceProviderRegistration,
  replaceExternalVoiceProviderProjectionAuthority } = await import('@/voice/registry/externalVoiceProviderRegistrations');
const { VoiceCredentialItem } = await import('./CredentialItem');
const { VoiceRawCredentialAccessReview } = await import('./VoiceRawCredentialAccessReview');
const { ModalProvider } = await import('@/modal');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { SavedSecretPickerModal } = await import('@/components/ui/forms/valueRefs/SavedSecretPickerModal');
const { storage } = await import('@/sync/domains/state/storage');
const { refreshSavedSecretCatalog } = await import('@/sync/engine/settings/savedSecretCatalogEngine');
const token = Object.freeze({});
const contribution = { pluginId: 'com.acme.voice', localId: 'conversation' } as const;
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
let selectedSecretRef: string | undefined;
let pickerProps: React.ComponentProps<typeof SavedSecretPickerModal> | undefined;

function register(declaration: typeof credentialSourceDeclaration | null = credentialSourceDeclaration) {
  removeExternalVoiceProviderRegistration(token);
  if (!declaration) { replaceExternalVoiceProviderProjectionAuthority(null, token, new Map()); return; }
  const providerId = 'com.acme.voice/conversation';
  const descriptor = createVoiceProviderRegistry({
    bundledContributions: [{ pluginId: contribution.pluginId, providerId, declaration }],
    bundledPresentations: [{ providerId, settingsSectionId: 'voice.acme.conversation' }],
  }).get(providerId);
  if (!descriptor) throw new Error('Fixture Voice declaration not admitted');
  commitExternalVoiceProviderRegistration({ token, ...contribution, providerId, descriptor, adapter: null });
}

function secretSettings(source: 'none' | 'savedSecret' = 'none', reference: string | null = null, approvedDigest?: string) {
  return settingsParse({
    secrets: [{ id: 'stored-secret', name: 'Acme key', kind: 'apiKey',
      encryptedValue: { _isSecretValue: true, value: 'retained-secret' }, createdAt: 1, updatedAt: 1 }],
    voiceSettingsV1: { credentialBindings: reference === null ? [] : [{
      contribution, credentialSlotId: 'api-key', credentialSource: { kind: source },
      credentialBindings: { account: { 'api-key': reference } },
      ...(approvedDigest ? { approvedRecipientContractDigest: approvedDigest } : {}),
    }] },
  });
}

async function setup(settings: Settings = settingsParse({}), connectedPurposes: ConnectedPurposeCatalogV1 = { v: 1, bindings: [] }) {
  account = await createSecretSettingsTestHarness({ settings: settingsParse({ ...settings,
    actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'secrets.shared.promote': ['ui'], 'secrets.shared.create': ['ui'] } },
  }), connectedPurposes });
  await account.purposes!.hydrate(account.scope);
  await refreshSavedSecretCatalog(account.scope);
  if (settings.secrets.length) {
    // The catalog publishes its foreground read before the real maintenance import finishes.
    await vi.waitFor(() => expect(account!.resources).toHaveLength(settings.secrets.length));
    await refreshSavedSecretCatalog(account.scope);
  }
  account.settingsWrites.length = 0;
  account.promotions.length = 0;
  account.purposes!.writes.length = 0;
}
function storedRef() {
  const resource = account?.resources.find(resource => 'name' in resource.entry && resource.entry.name === 'Acme key');
  if (!resource || !('ref' in resource.entry)) throw new Error('Expected acknowledged SavedSecret Resource');
  return resource.entry.ref;
}
function binding() { return account?.persistedSettings.voiceSettingsV1.credentialBindings[0]; }
function choose(ref = storedRef()) {
  selectedSecretRef = ref;
}
async function render(options: Partial<React.ComponentProps<typeof VoiceCredentialItem>> = {}) {
  return renderScreen(<InjectedAuthProvider credentials={account!.credentials}><ModalProvider><VoiceCredentialItem testID="credential" title="API key" promptTitle="Connect" promptDescription="Paste key"
    contribution={contribution} credentialSlotId="api-key" credentialSourcePurpose="voice.client-auth"
    credentialSourceDeclaration={credentialSourceDeclaration} disclosePlainStorage={true} {...options} /></ModalProvider></InjectedAuthProvider>, {
    // Test Renderer has no native layout engine; keep the real Popover measurable and interactive.
    createNodeMock: element => element.props.testID === 'credential' ? {
      measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 100, 320, 48),
    } : null,
  });
}
async function gesture(screen: Awaited<ReturnType<typeof render>>, id: 'enterNew' | 'useSavedSecret' = 'enterNew') {
  const reviewing = screen.tree.findAll(node => node.props.title === 'API key' && typeof node.props.onPress === 'function')[0]?.props.subtitle
    === t('settingsVoice.externalCredentials.reviewRequired');
  const confirmationsBefore = boundary.confirm.mock.calls.length;
  const menu = screen.tree.findAllByType(DropdownMenu)[0];
  if (menu) {
    const trigger = screen.tree.findAll(node => node.props.title === 'API key' && typeof node.props.onPress === 'function')[0];
    if (!trigger) throw new Error('Credential dropdown trigger missing');
    await act(async () => { trigger.props.onPress(); });
    await vi.waitFor(() => expect(screen.tree.findAllByType(DropdownMenu)[0]?.props.open).toBe(true));
    await vi.waitFor(() => {
      const option = screen.tree.findByTestId(`dropdown-option-${id}`);
      expect(option).not.toBeNull();
      // Opening schedules native anchor measurement before the menu becomes tappable.
      for (let node = option; node; node = node.parent) expect(node.props.visible).not.toBe(false);
    });
    await screen.tree.pressByTestIdAsync(`dropdown-option-${id}`);
  } else {
    if (id !== 'enterNew') throw new Error('SavedSecret selector missing');
    await screen.tree.pressByTestIdAsync('credential');
  }
  if (id === 'useSavedSecret') {
    const ref = selectedSecretRef ?? storedRef();
    await vi.waitFor(() => expect(screen.tree.findByTestId(`saved-secret:${ref}`)).not.toBeNull());
    // React Test Renderer exposes props as an untyped SDK bag at this component boundary.
    pickerProps = screen.tree.findAllByType(SavedSecretPickerModal)[0]?.props as React.ComponentProps<typeof SavedSecretPickerModal> | undefined;
    await screen.tree.pressByTestIdAsync(`saved-secret:${ref}`);
  } else if (reviewing) {
    await vi.waitFor(() => expect(boundary.confirm.mock.calls.length).toBeGreaterThan(confirmationsBefore));
  } else {
    await vi.waitFor(() => expect(Boolean(screen.tree.findByTestId('web-prompt-input')) || boundary.alert.mock.calls.length > 0).toBe(true));
    if (screen.tree.findByTestId('web-prompt-input')) {
      await act(async () => { screen.tree.changeTextByTestId('web-prompt-input', 'new-secret'); });
      await screen.tree.pressByTestIdAsync('web-prompt-confirm');
    }
  }
}
function failures() { return log.getLogs().filter(message => message.includes('voice_credential:')); }

describe('VoiceCredentialItem', () => {
  let webLocks: ReturnType<typeof installWebLockManagerMock>;
  beforeEach(() => {
    webLocks = installWebLockManagerMock();
    register();
    vi.clearAllMocks();
    log.clear();
    selectedSecretRef = undefined;
    pickerProps = undefined;
    boundary.confirmDecisions = [];
    // Native Alert is the OS presentation boundary. Press its real supplied
    // button callbacks; ModalManager still owns the confirmation promise.
    boundary.nativeAlert.mockImplementation((title, message, buttons) => {
      if (buttons?.length === 2) {
        boundary.confirm(title, message);
        buttons[boundary.confirmDecisions.shift() === false ? 0 : 1]?.onPress?.();
      } else {
        boundary.alert(title, message);
        buttons?.[0]?.onPress?.();
      }
    });
  });
  afterEach(async () => {
    standardCleanup();
    removeExternalVoiceProviderRegistration(token);
    await account?.dispose();
    account = undefined;
    webLocks.restore();
  });

  it('mounts raw review only for the selected current source, realm and phase', async () => {
    await setup(secretSettings('savedSecret', 'stored-secret'));
    const screen = await render({ rawCredentialReviewGrants: credentialSourceDeclaration.credentials?.sources[0]?.rawGrants ?? [] });
    const review = screen.tree.findAllByType(VoiceRawCredentialAccessReview)[0];
    expect(review?.props.contribution).toEqual(contribution);
    expect(review?.props.rawGrant).toEqual(credentialSourceDeclaration.credentials?.sources[0]?.rawGrants?.[0]);
    await screen.update(<InjectedAuthProvider credentials={account!.credentials}><ModalProvider><VoiceCredentialItem testID="credential" title="API key" promptTitle="Connect" promptDescription="Paste key"
      contribution={contribution} credentialSlotId="api-key" credentialSourcePurpose="voice.client-auth"
      credentialSourceDeclaration={credentialSourceDeclaration} rawCredentialReviewGrants={[]} disclosePlainStorage /></ModalProvider></InjectedAuthProvider>);
    expect(screen.tree.findAllByType(VoiceRawCredentialAccessReview)).toHaveLength(0);
  });

  it('selects a stored SavedSecret without prompting or changing its material', async () => {
    await setup(secretSettings());
    const ref = storedRef();
    const before = structuredClone(account!.resources);
    choose(ref);
    const screen = await render();
    await gesture(screen, 'useSavedSecret');
    await vi.waitFor(() => expect(binding()).toMatchObject({ credentialSource: { kind: 'savedSecret' },
      credentialBindings: { account: { 'api-key': ref } } }));
    expect(account!.resources).toEqual(before);
    expect(screen.tree.findByTestId('web-prompt-input')).toBeNull();
    expect(pickerProps).toMatchObject({ includeNoneRow: false, allowAdd: false, allowEdit: false });
  });

  it('replaces a dormant SavedSecret without changing the selected Connected Account', async () => {
    const connectedPurpose = { purpose: { consumer: contribution, purpose: 'voice.client-auth' },
      target: { kind: 'account' as const, account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'codex-account' } } };
    const initial = secretSettings('savedSecret', 'stored-secret');
    await setup(settingsParse({ ...initial,
      voiceSettingsV1: { credentialBindings: [{ ...initial.voiceSettingsV1.credentialBindings[0], credentialSource: { kind: 'connectedAccount' } }] },
    }), { v: 1, bindings: [connectedPurpose] });
    const declaration = VoiceProviderContributionSchema.parse({ ...credentialSourceDeclaration, credentials: {
      ...credentialSourceDeclaration.credentials, sources: [...credentialSourceDeclaration.credentials!.sources,
        { kind: 'connectedAccount', service: connectedPurpose.target.account.service }],
    } });
    register(declaration);
    const changed = vi.fn();
    const screen = await render({ credentialSourcePurpose: undefined, credentialSourceDeclaration: declaration, onChanged: changed });
    await gesture(screen);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(binding()).toMatchObject({ credentialSource: { kind: 'connectedAccount' } });
    if (!account) throw new Error('Expected the restored credential Account');
    expect(account.purposes!.value.bindings).toEqual([connectedPurpose]);
    expect(account.resources).toHaveLength(2);
  });

  it.each([
    ['a destroyed reference', 'savedSecret', 'destroyed-secret'],
    ['the same reference under a dormant source', 'none', 'stored-secret'],
  ] as const)('repairs %s through the atomic source owner', async (_label, source, reference) => {
    await setup(secretSettings(source, reference));
    const ref = storedRef();
    choose(ref);
    const screen = await render();
    await gesture(screen, 'useSavedSecret');
    await vi.waitFor(() => expect(binding()).toMatchObject({ credentialSource: { kind: 'savedSecret' },
      credentialBindings: { account: { 'api-key': ref } } }));
    expect(account!.purposes!.writes).toHaveLength(1);
    expect(failures()).toEqual([]);
  });

  it('declining recipient approval records a safe failure and changes no credential', async () => {
    await setup(secretSettings());
    choose();
    boundary.confirmDecisions = [false];
    const screen = await render({ recipientContract });
    await gesture(screen, 'useSavedSecret');
    await vi.waitFor(() => expect(failures()).toHaveLength(1));
    expect(failures()[0]).toContain('recipient_contract_not_approved');
    expect(failures()[0]).not.toContain('retained-secret');
    expect(binding()).toBeUndefined();
    expect(account!.purposes!.writes).toHaveLength(0);
  });

  it('reports missing Settings CAS authority instead of claiming the selection changed', async () => {
    await setup(secretSettings());
    choose();
    storage.setState({ settingsVersion: null });
    const screen = await render();
    await gesture(screen, 'useSavedSecret');
    await vi.waitFor(() => expect(failures()[0]).toContain('voice_credential_source_declaration_unavailable'));
    expect(account!.purposes!.writes).toHaveLength(0);
  });

  it('atomically creates and activates the new SavedSecret', async () => {
    await setup();
    const changed = vi.fn();
    const screen = await render({ onChanged: changed });
    await gesture(screen);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(binding()).toMatchObject({ credentialSource: { kind: 'savedSecret' } });
    expect(account!.resources).toHaveLength(1);
    expect(account!.persistedSettings.secrets).toEqual([]);
    expect(account!.promotions).toHaveLength(1);
  });

  it('fails closed when the current qualified declaration is unavailable', async () => {
    await setup();
    register(null);
    const screen = await render({ credentialSourceDeclaration: undefined });
    await gesture(screen);
    await vi.waitFor(() => expect(boundary.alert).toHaveBeenCalledWith(t('common.error'), t('settingsVoice.local.voiceCredential.operationFailed')));
    expect(account!.resources).toHaveLength(0);
    expect(binding()).toBeUndefined();
  });

  it('reports a save conflict without claiming the credential changed', async () => {
    await setup();
    account!.setRejectSettingsWrites(true);
    const changed = vi.fn();
    const screen = await render({ onChanged: changed });
    await gesture(screen);
    await vi.waitFor(() => expect(boundary.alert).toHaveBeenCalledWith(t('common.error'), t('settingsVoice.local.voiceCredential.operationFailed')));
    expect(changed).not.toHaveBeenCalled();
    expect(account!.resources).toHaveLength(0);
    expect(binding()).toBeUndefined();
  });

  it.each(['useSavedSecret', 'enterNew'] as const)('reports an ambiguous %s write without claiming it became effective', async kind => {
    await setup(kind === 'useSavedSecret' ? secretSettings() : settingsParse({}));
    if (kind === 'useSavedSecret') choose();
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    let responseLost = false;
    setRuntimeFetch(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (responseLost) throw new TypeError('HTTP unavailable after accepted mutation');
      const response = await account!.request(url, init);
      if (init?.method === 'POST' && (path === account!.purposes!.path || path.endsWith('/promote'))) {
        responseLost = true;
        throw new TypeError('HTTP response lost after accepted mutation');
      }
      return response;
    });
    const changed = vi.fn();
    const screen = await render({ onChanged: changed });
    await gesture(screen, kind);
    await vi.waitFor(() => expect(boundary.alert).toHaveBeenCalledWith(t('common.error'), t('settingsProviders.errors.mutationOutcomeUnknownDescription')));
    expect(changed).not.toHaveBeenCalled();
    expect(failures()[0]).toContain(kind === 'useSavedSecret' ? 'saved_secret_binding_outcome_unknown' : 'saved_secret_replacement_outcome_unknown');
  });

  it('discloses bounded recipient facts and cancellation persists or sends nothing', async () => {
    await setup();
    boundary.confirmDecisions = [true, false];
    const screen = await render({ recipientContract });
    await gesture(screen);
    await vi.waitFor(() => expect(boundary.confirm).toHaveBeenCalledTimes(2));
    const body = String(boundary.confirm.mock.calls[1]?.[1]);
    for (const fact of ['com.acme.voice', '@acme/voice', 'verified', 'npm:https://registry.npmjs.org:@acme', 'conversation', 'voice.session-create',
      'mutation', 'POST', 'https://api.example.com', '/v1/sessions', 'authorization', 'bearer', '4096', '65536',
      'voice.catalog', 'read', 'GET', 'https://catalog.example.com', '/v1/voices', 'x-api-key', 'raw', '0', '32768']) expect(body).toContain(fact);
    expect(body.indexOf('a-create')).toBeLessThan(body.indexOf('z-catalog'));
    for (const privateValue of ['new-secret', 'DO_NOT_SHOW_STATIC', 'DO_NOT_SHOW_HEADER', 'DO_NOT_SHOW_BODY']) expect(body).not.toContain(privateValue);
    expect(account!.resources).toHaveLength(0);
    expect(binding()).toBeUndefined();
  });

  it('requires review of a retained credential and stores approval without disclosing or replacing its material', async () => {
    await setup(secretSettings('savedSecret', 'stored-secret', `sha256:${'0'.repeat(64)}`));
    const before = structuredClone(account!.resources);
    const onStatusChanged = vi.fn();
    const screen = await render({ recipientContract, onStatusChanged });
    await vi.waitFor(() => expect(onStatusChanged).toHaveBeenCalledWith(expect.objectContaining({ status: 'review_required', usable: false })));
    expect(screen.tree.findAll(node => node.props.title === 'API key' && typeof node.props.onPress === 'function')[0]?.props.subtitle).toBe(t('settingsVoice.externalCredentials.reviewRequired'));
    await gesture(screen);
    await vi.waitFor(() => expect(onStatusChanged).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready', usable: true })));
    expect(screen.tree.findByTestId('web-prompt-input')).toBeNull();
    expect(account!.resources).toEqual(before);
    expect(JSON.stringify(boundary.confirm.mock.calls)).not.toContain('retained-secret');
    const { resolveAccountVoiceCredentialApprovalDigest } = await import('./accountVoiceCredential');
    const { resolveSavedSecretReference } = await import('@/sync/store/settings/savedSecretCatalogSnapshot');
    expect(binding()).toMatchObject({ approvedRecipientContractDigest: resolveAccountVoiceCredentialApprovalDigest({
      requiredRecipientContractDigest: createRecipientContractDigestV1(recipientContract),
      savedSecret: resolveSavedSecretReference(account!.scope, [], storedRef()),
    }) });
  });

  it('reports an unreadable Settings snapshot rather than claiming the stored key is missing', async () => {
    await setup(secretSettings());
    const current = storage.getState().settings;
    const invalid: unknown = { ...current, voiceSettingsV1: { ...current.voiceSettingsV1, credentialBindings: [{ notACredentialBinding: true }] } };
    // Corrupt persisted input is deliberately outside the typed Settings contract.
    storage.setState({ settings: invalid as Settings });
    const onStatusChanged = vi.fn();
    const screen = await render({ onStatusChanged });
    expect(screen.tree.findAll(node => node.props.title === 'API key' && typeof node.props.onPress === 'function')[0]?.props.subtitle).toBe(t('voice.readiness.credential_unknown'));
    await vi.waitFor(() => expect(onStatusChanged).toHaveBeenCalledWith({ status: 'unknown', exists: false, usable: false, source: null, credentialIdentity: null }));
  });
});

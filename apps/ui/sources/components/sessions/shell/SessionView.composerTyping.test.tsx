import 'fake-indexeddb/auto';
import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen as renderCanonicalScreen } from '@/dev/testkit/render/renderScreen';
import { createReactNavigationNativeMock } from '@/dev/testkit/mocks/reactNavigation';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { PendingRequestedActionV1Schema } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { PENDING_INPUT_PROTOCOL_VERSION_V3 } from '@happier-dev/protocol/clientCompatibility/primitives';
import { MINIMUM_CLI_PENDING_QUEUE_V2_VERSION } from '@/utils/system/versionUtils';
import type { SessionComposerModel, SessionComposerRenderer } from '@/components/sessions/composer/sessionComposerModel';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';

/**
 * Typing stays local to the mounted input while the real draft persists and restores.
 * Submission then resolves and acknowledges through the actual Home/Sync owners.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

vi.mock('socket.io-client', async (importOriginal) =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const platformState = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'web' }));
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    View: 'View', Text: 'Text', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator',
    useWindowDimensions: () => ({ width: 1200, height: 800 }),
    Platform: { get OS() { return platformState.os; }, select: (spec: Record<string, unknown>) => spec[platformState.os] ?? spec.default },
  });
});
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('@/modal', async () =>
  (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () =>
  (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    router: { push: vi.fn(), back: vi.fn() }, pathname: '/',
  }).module);
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
vi.mock('react-native-safe-area-context', () => ({
  initialWindowMetrics: {
    frame: { x: 0, y: 0, width: 0, height: 0 },
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
  },
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@react-navigation/native', () => ({
  ...createReactNavigationNativeMock(), useFocusEffect: () => {}, useIsFocused: () => true,
}));

// Observe shell slots without mounting their separate transcript/native renderers.
// All Session, Account, draft, readiness, feature and send decisions remain real.
vi.mock('@/components/sessions/transcript/AgentContentView', () => ({
  AgentContentView: (props: { input?: React.ReactNode }) => React.createElement('AgentContentView', props, props.input),
}));
vi.mock('@/components/sessions/transcript/ChatHeaderView', () => ({ ChatHeaderView: () => null }));
vi.mock('@/components/sessions/transcript/ChatList', () => ({ ChatList: () => null }));
vi.mock('@/components/ui/empty/EmptyMessages', () => ({ EmptyMessages: () => null }));
vi.mock('@/components/ui/forms/Deferred', () => ({
  Deferred: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
}));
vi.mock('@/components/sessions/actions/SessionHeaderActionMenu', () => ({ SessionHeaderActionMenu: () => null }));
vi.mock('@/components/voice/surface/VoiceSurface', () => ({ VoiceSurface: () => null }));
vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({ AttachmentFilePicker: () => null }));
vi.mock('@/components/ui/code/editor/CodeEditor', () => ({ CodeEditor: () => null }));
vi.mock('@/components/sessions/agentInput', () => ({
  AgentInput: (props: Record<string, unknown>) => React.createElement('AgentInput', props),
}));

const { installSessionPaneRuntimeTestHarness } = await import('../panes/sessionPaneRuntimeTestHarness');
const submittedMessages: Array<Readonly<{
  localId: string;
  content: ReturnType<typeof SessionStoredMessageContentSchema.parse>;
  requestedAction: ReturnType<typeof PendingRequestedActionV1Schema.parse>;
}>> = [];
const runtime = installSessionPaneRuntimeTestHarness({
  features: () => {
    const features = createRootLayoutFeaturesResponse();
    features.capabilities.session.pendingInput = { protocolVersion: PENDING_INPUT_PROTOCOL_VERSION_V3 };
    return features;
  },
  rpc: async () => { throw new RpcError('Daemon method unavailable', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE); },
  request: async (url, init) => {
    if (new URL(String(url)).pathname !== '/v2/sessions/s1/pending') return null;
    if ((init?.method ?? 'GET') === 'GET') return Response.json({ pending: submittedMessages.map(message => ({
      ...message, messageRole: 'user', status: 'queued', createdAt: 1, updatedAt: 1, position: 1,
    })) });
    if (init?.method !== 'POST') throw new Error('Unexpected Pending write method');
    const body: unknown = JSON.parse(String(init.body));
    if (!body || typeof body !== 'object' || !('localId' in body) || typeof body.localId !== 'string'
      || !('content' in body) || !('requestedAction' in body)) throw new Error('Expected the real Pending submission envelope');
    const message = {
      localId: body.localId,
      content: SessionStoredMessageContentSchema.parse(body.content),
      requestedAction: PendingRequestedActionV1Schema.parse(body.requestedAction),
    };
    submittedMessages.push(message);
    return Response.json({ localId: message.localId, requestedAction: message.requestedAction,
      pending: { ...message, messageRole: 'user', status: 'queued', createdAt: 1, updatedAt: 1, position: 1 } });
  },
});
const { storage } = await import('@/sync/domains/state/storage');
const sessionUtils = await import('@/utils/sessions/sessionUtils');
const shellRenders = vi.spyOn(sessionUtils, 'useSessionStatus');
const resolver = await import('@/sync/domains/input/slashCommands/resolveSessionComposerSend');
const resolveSessionComposerSendSpy = vi.spyOn(resolver, 'resolveSessionComposerSend');
const { SessionView } = await import('./SessionView');
const { getSessionComposerDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
await loadSyncSingletonForTests();
const { sync } = await import('@/sync/sync');

function surfaceElement(renderComposer?: SessionComposerRenderer) {
  return <SessionView id="s1" routeServerId={runtime.serverId} surfaceFocusedOverride surfaceVisibleOverride
    {...(renderComposer ? { renderComposer } : {})} />;
}

function renderScreen() {
  return renderCanonicalScreen(surfaceElement(), { wrapper: runtime.Wrapper });
}

function findAgentInput(screen: Awaited<ReturnType<typeof renderScreen>>) {
  const inputs = screen.tree.findAllByType('AgentInput' as React.ElementType);
  return inputs[inputs.length - 1]!;
}

async function typeCharacters(screen: Awaited<ReturnType<typeof renderScreen>>, from: string, text: string) {
  let typed = from;
  for (const character of text) {
    typed += character;
    const next = typed;
    await renderer.act(async () => { findAgentInput(screen).props.onChangeText(next); });
  }
  return typed;
}

function storedDraftText(): unknown {
  const scope = runtime.accountScope;
  if (!scope) throw new Error('Expected the restored composer Account');
  return getSessionComposerDraftSnapshot(scope, { kind: 'session', sessionId: 's1' })?.composer.text.value;
}

describe('SessionView composer typing', () => {
  beforeEach(async () => {
    platformState.os = 'ios';
    submittedMessages.length = 0;
    resolveSessionComposerSendSpy.mockClear();
    storage.setState({
      settings: { ...settingsDefaults, experiments: true },
      localSettings: { ...storage.getState().localSettings, uiMultiPanePanelsEnabled: false },
    });
    storage.getState().applySessions([createSessionFixture({
      id: 's1', serverId: runtime.serverId, active: true,
      pendingVersion: 1, pendingCount: 0,
      metadata: { machineId: 'm1', host: 'test-home', flavor: 'codex', path: '/tmp', homeDir: '/tmp',
        version: MINIMUM_CLI_PENDING_QUEUE_V2_VERSION },
      agentState: { controlledByUser: true },
    })]);
    storage.getState().applyMachines([createMachineFixture({ id: 'm1', activeAt: Date.now() })], true, {
      sourceServerId: runtime.serverId,
    });
    expect((await sync.ensureSessionVisibleForMessageRoute('s1', {
      serverId: runtime.serverId, forceRefresh: true, hydrateMessages: false,
    })).kind).toBe('available');
  });

  it('keeps typing out of the loaded shell while the draft persists, restores and submits', async () => {
    const screen = await renderScreen();
    expect(screen.tree.findAllByType('AgentInput' as React.ElementType)).toHaveLength(1);

    const first = await typeCharacters(screen, '', 'hello');
    const rendersAfterFirstBurst = shellRenders.mock.calls.length;
    const typed = await typeCharacters(screen, first, ' world, typed');
    expect(shellRenders.mock.calls.length - rendersAfterFirstBurst).toBe(0);
    expect(findAgentInput(screen).props.value).toBe('hello world, typed');
    expect(storedDraftText()).toBe(typed);

    // An unsent draft restores across a real same-Account mount lifetime.
    await screen.unmount();
    const reopened = await renderScreen();
    expect(findAgentInput(reopened).props.value).toBe(typed);
    expect(storedDraftText()).toBe(typed);

    // The actual resolver and send path read the restored input, then clear only on acceptance.
    await renderer.act(async () => { findAgentInput(reopened).props.onSend(); });
    await vi.waitFor(() => expect(submittedMessages).toHaveLength(1));
    expect(resolveSessionComposerSendSpy).toHaveBeenCalledWith(expect.objectContaining({ input: typed }));
    expect(submittedMessages[0]).toMatchObject({
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: typed } } },
    });
    await vi.waitFor(() => {
      expect(findAgentInput(reopened).props.value).toBe('');
      expect(storedDraftText() ?? '').toBe('');
    });
    await reopened.unmount();
  });

  it('hosts the same composer contract in the screen or a sheet without copying the draft or send path', async () => {
    let placement = 'SessionComposerHost';
    const models: SessionComposerModel[] = [];
    const renderComposer: SessionComposerRenderer = composer => {
      models.push(composer);
      return React.createElement(placement, null, composer.content);
    };
    const screen = await renderCanonicalScreen(surfaceElement(renderComposer), { wrapper: runtime.Wrapper });
    expect(screen.tree.findAllByType('SessionComposerHost' as React.ElementType)).toHaveLength(1);
    await typeCharacters(screen, '', 'Ask about this selection');
    const before = findAgentInput(screen).props;
    const beforeModel = models.at(-1);
    expect(beforeModel).toBeDefined();

    placement = 'PhoneAskSheetHost';
    await screen.update(surfaceElement(composer => renderComposer(composer)));
    expect(screen.tree.findAllByType('AgentInput' as React.ElementType)).toHaveLength(1);
    expect(screen.tree.findAllByType('PhoneAskSheetHost' as React.ElementType)).toHaveLength(1);
    const inSheet = findAgentInput(screen).props;
    expect(inSheet.value).toBe('Ask about this selection');
    // The host changes; the real controller's handlers and selected agent/model do not.
    for (const key of ['onSend', 'onChangeText', 'onAbort', 'agentType', 'modelMode', 'attachmentRowItems']) {
      expect(before).toHaveProperty(key);
      expect(inSheet[key], key).toEqual(before[key]);
    }
    // Presentation closures may refresh on any render; compare the controls and choices they present.
    const describeChip = (chip: AgentInputExtraActionChip) => ({
      key: chip.key,
      controlId: chip.controlId,
      labelPolicy: chip.labelPolicy,
      title: chip.collapsedOptionsPopover?.title ?? chip.collapsedContentPopover?.title,
      selectedOptionId: chip.collapsedOptionsPopover?.selectedOptionId,
    });
    expect(inSheet.extraActionChips.map(describeChip)).toEqual(before.extraActionChips.map(describeChip));
    expect(models.at(-1)?.ref).toBe(beforeModel?.ref);
    expect(models.at(-1)?.address).toBe(beforeModel?.address);
    expect(models.at(-1)?.focus).toBe(beforeModel?.focus);
    expect(models.at(-1)?.ref).toEqual({ kind: 'session', sessionId: 's1' });
    expect(storedDraftText()).toBe('Ask about this selection');
    await renderer.act(async () => { findAgentInput(screen).props.onSend(); });
    await vi.waitFor(() => expect(submittedMessages).toHaveLength(1));
    expect(submittedMessages[0]).toMatchObject({
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Ask about this selection' } } },
    });
    await vi.waitFor(() => expect(findAgentInput(screen).props.value).toBe(''));

    placement = 'SessionComposerHost';
    await screen.update(surfaceElement(composer => renderComposer(composer)));
    expect(screen.tree.findAllByType('AgentInput' as React.ElementType)).toHaveLength(1);
    expect(findAgentInput(screen).props.value).toBe('');
    await screen.unmount();
  });

  it('keeps the composer usable when a web render has no DOM selection source', async () => {
    platformState.os = 'web';
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
      const { Platform } = await import('react-native');
      expect(Platform.OS).toBe('web');
      expect(typeof document).toBe('undefined');
      screen = await renderScreen();
      expect(screen.tree.findAllByType('AgentInput' as React.ElementType)).toHaveLength(1);
      await typeCharacters(screen, '', 'A draft without DOM selection');
      expect(findAgentInput(screen).props.value).toBe('A draft without DOM selection');
    } finally {
      await screen?.unmount();
      platformState.os = 'ios';
    }
  });
});

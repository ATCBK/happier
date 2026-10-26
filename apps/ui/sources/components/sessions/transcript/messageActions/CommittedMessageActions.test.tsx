import * as React from 'react';
import { act } from 'react-test-renderer';
import type { TestGestureChain } from '@/dev/testkit/mocks/gestureHandler';
import type { RowActionHoverHost } from './rowActionRevealHost';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserTextMessage, AgentTextMessage } from '@happier-dev/session-core/messages';
import type { TranscriptForkCommon } from '../transcriptSessionCommon';
import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
const platformState = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'android' | 'web' }));
vi.mock('react-native-gesture-handler', async () => (await import('@/dev/testkit/mocks/gestureHandler')).createGestureHandlerMock());
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { get OS() { return platformState.os; }, select: (values: Record<string, unknown>) => values[platformState.os] ?? values.default ?? values.web } });
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// Home fixtures can reach React Native too: configure its native boundary before importing them.
const { createHomeGovernanceHarness, installHomeGovernanceBoundaries } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
// Load consumers after the canonical native and HTTP boundaries are configured.
const { View } = await import('react-native');
const { renderScreen, standardCleanup, createSessionFixture, createTestSessionTranscriptSource, wrapWithSessionTranscriptSource } = await import('@/dev/testkit');
const { TranscriptMessageSelectionProvider } = await import('../messageSelection/TranscriptMessageSelectionContext');
const { ContextMenu } = await import('@/components/ui/forms/dropdown/ContextMenu');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const featuresClient = await import('@/sync/api/capabilities/serverFeaturesClient');
const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
const { CommittedMessageActions } = await import('./CommittedMessageActions');
const { createPluginMessageActionHost, PluginMessageActionHostProvider } = await import('./PluginMessageActions');
const { resolveSelectableMessageText } = await import('../messageSelection/resolveSelectableMessageText');
const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
const { createPluginUiTranslationRuntime, PluginUiTranslationRuntimeProvider } = await import('@/sync/domains/plugins/ui/i18n');
const { commitPreferredLanguage, getPreferredLanguage } = await import('@/text/preferredLanguage');
let serverId = '';
let activeFeatureSubscriptions = 0;
let restoreFeatureSubscriptionObservation = () => {};
beforeEach(async () => {
    platformState.os = 'ios';
    bodyRenders = 0;
    await home.reset();
    serverId = await home.addHome({ serverUrl: 'https://committed-actions.test', name: 'Action test', accountId: 'account-a' });
    getStorage().setState({ profileScope: { serverId, accountId: 'account-a' }, settings: settingsDefaults });
    getStorage().getState().applySettingsLocal({ experiments: true, featureToggles: { automations: true, workflows: true } });
    await featuresClient.getServerFeaturesSnapshot({ serverId, force: true });
    activeFeatureSubscriptions = 0;
    const subscribe = featuresClient.subscribeServerFeaturesSnapshot;
    // Observe the real feature-store lifetime without replacing its decision or subscriber.
    const observation = vi.spyOn(featuresClient, 'subscribeServerFeaturesSnapshot').mockImplementation((listener) => {
        activeFeatureSubscriptions += 1;
        const dispose = subscribe(listener);
        return () => { activeFeatureSubscriptions -= 1; dispose(); };
    });
    restoreFeatureSubscriptionObservation = () => observation.mockRestore();
});
afterEach(() => { standardCleanup(); restoreFeatureSubscriptionObservation(); });

const forkCommon: TranscriptForkCommon = {
    sessionReplayEnabled: true, sessionReplayMaxSeedChars: 1000, sessionReplayStrategy: 'recent_messages', sessionReplaySummaryRunnerV1: null,
    executionRunsEnabled: false, agentSwitchingEnabled: false,
    sessionForkSupportSource: { metadata: null },
};
const noop = () => {};
let nextBodyId = 0;
let bodyRenders = 0;

function MessageBody(props: Readonly<{ row: React.ReactNode }>) {
    bodyRenders += 1;
    const [identity] = React.useState(() => String(++nextBodyId));
    return <View accessibilityLabel={identity} testID="committed-message-body">{props.row}</View>;
}

function element(kind: 'user-text' | 'agent-text', overrides: Partial<typeof settingsDefaults> = {}, structured = false, id = 'm1', pinned = false, text = 'Useful prompt', unsupported = false, thinking = false, hoverProps?: RowActionHoverHost['hoverProps'], openDiscussionSource?: React.ComponentProps<typeof CommittedMessageActions>['openDiscussionSource'], committedMessageId = id, showActions = true) {
    const message: UserTextMessage | AgentTextMessage = { kind, id, localId: id, text, createdAt: 1, seq: 5, transcriptBlockIndex: 0,
        ...(kind === 'agent-text' ? { isThinking: thinking } : {}),
        messageActionReference: { v: 1, sessionId: 's1', messageId: committedMessageId, observedRevision: 'r1' } };
    return wrapWithSessionTranscriptSource(<TranscriptMessageSelectionProvider sessionId="s1" eligibleMessageIdsInOrder={[id]}>
        <CommittedMessageActions message={message} sessionId="s1" serverId={serverId}
            selectableText={resolveSelectableMessageText({ message, isStructuredOnly: structured, hasAttachmentBlockToStrip: true })}
            copyText={message.text} isStructuredOnly={structured} hasUnsupportedContent={unsupported}
            canFork forkCommon={forkCommon} isForkAllowed={() => true}
            settings={{ ...settingsDefaults, ...overrides, workspacePath: null, debugInformationEnabled: false }}
            rollbackAction={{ target: { type: 'before_user_message', userMessageSeq: 5 }, restoredDraftText: message.text }}
            onToggleMessagePin={noop} messagePins={pinned ? [{ version: 1, sessionId: 's1', seq: 5, transcriptBlockIndex: 0,
                routeMessageId: `local:${id}`, role: kind === 'user-text' ? 'user' : 'assistant', pinnedAtMs: 1, label: null }] : []}
            showActions={showActions} showPinAction timestampText={null} invertTimestampAndActions={false}
            onActionsFocus={noop} onActionsBlur={noop} hoverProps={hoverProps} openDiscussionSource={openDiscussionSource}>
            {(row) => <MessageBody row={row} />}
        </CommittedMessageActions>
    </TranscriptMessageSelectionProvider>, createTestSessionTranscriptSource({ sessionId: 's1', serverId }));
}

describe('Committed row and native menu availability', () => {
    it('defers hidden row Action copy until native hold opens the menu without replacing the message body', async () => {
        const previousLanguage = getPreferredLanguage();
        commitPreferredLanguage('fr');
        const projection: PluginUiProjectionModel = { ...EMPTY_PLUGIN_UI_PROJECTION, translationsByPluginId: {
            'acme.preview': { id: 'translations:acme.preview', pluginId: 'acme.preview', contributionKind: 'translations',
                locales: ['en', 'fr', 'de'], resourceIdsByLocale: { en: 'copy-en', fr: 'copy-fr', de: 'copy-de' } },
        } };
        const reads: string[] = [];
        const runtime = createPluginUiTranslationRuntime({ projection, readResourceBytes: async (_source, _pluginId, resourceId) => {
            reads.push(resourceId);
            return new TextEncoder().encode(JSON.stringify({ 'preview.title': resourceId === 'copy-fr' ? 'Aperçu' : 'Preview' }));
        } });
        const contribution: PluginProjectionEntry = {
            pluginId: 'acme.preview', title: 'Preview', description: null, version: '1.0.0', enabled: true,
            generation: 7, generationLabel: '7', status: null, provenance: null, diagnostics: [], resources: [], editableSettingsGroups: [],
            actions: [{ id: 'preview', occurrenceId: null, title: 'Preview', description: null, icon: null,
                localizedPresentation: { title: { key: 'preview.title', fallback: 'Preview' } },
                scopes: ['message'], surfaces: ['ui'], placementBindings: ['rowAction'],
                inputHints: null, priority: null, dangerLevel: 'safe', confirmation: null, available: true }],
        };
        const host = createPluginMessageActionHost({ sessionId: 's1', resolveCurrent: () => ({
            pluginProjectionById: { 'acme.preview': contribution }, pluginUiProjection: projection,
            host: { machineId: 'machine-1', serverId, sessionId: 's1', isCurrent: () => true },
        }) });
        const screen = await renderScreen(<PluginUiTranslationRuntimeProvider runtime={runtime}>
            <PluginMessageActionHostProvider host={host}>
                {element('agent-text', { transcriptMessageMakeRepeatableActionEnabled: false }, false, 'm1', false,
                    'Useful prompt', false, false, undefined, undefined, 'm1', false)}
            </PluginMessageActionHostProvider>
        </PluginUiTranslationRuntimeProvider>);
        try {
            const body = screen.findHostByTestId('committed-message-body');
            expect(reads).toEqual([]);
            const hold = screen.findAllByType('GestureDetector')[0].props.gesture as TestGestureChain;
            await act(async () => { hold.__handlers.onStart(); });
            expect(reads).toEqual(['copy-en', 'copy-fr']);
            expect(screen.findAllByType(ContextMenu)[0]?.props.items).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: 'plugin:acme.preview/preview', title: 'Aperçu' }),
            ]));
            expect(screen.findHostByTestId('committed-message-body')).toBe(body);
        } finally { await screen.unmount(); runtime.dispose(); commitPreferredLanguage(previousLanguage); }
    });

    it.each([false, true])('tracks Save as decision from the layout-1 owner view without rerendering for unrelated Session updates (Bot: %s)', async (bot) => {
        const previousState = getStorage().getState();
        const ownerMetadata = { ...createSessionFixture().metadata!, ...(bot ? { bot: { kind: 'bot' as const } } : {}), work: { memoryEnabled: true } };
        const { projectSessionSharedMetadataV1 } = await import('@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1');
        const session = createSessionFixture({ id: 's1', serverId, metadataLayoutVersion: 1,
            // Session's retained Metadata type also carries the schema-produced public envelope.
            metadata: projectSessionSharedMetadataV1({ metadata: ownerMetadata }) as unknown as NonNullable<ReturnType<typeof createSessionFixture>['metadata']>,
            ownerMetadataView: ownerMetadata });
        let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
        try {
            getStorage().getState().applySessions([session]);
            screen = await renderScreen(element('agent-text', { transcriptMessageMakeRepeatableActionEnabled: false }));
            const menuHasDecision = () => screen!.findAllByType(ContextMenu)[0]?.props.items.some((item: { id: string }) => item.id === 'saveDecision');
            expect(menuHasDecision()).toBe(true);
            expect(screen.findHostByTestId('transcript-message-save-decision:m1')).not.toBeNull();
            const renders = bodyRenders;
            await act(async () => {
                getStorage().getState().applySessions([createSessionFixture({ id: 'unrelated', serverId })]);
                getStorage().setState(state => ({ sessions: { ...state.sessions, s1: { ...session, updatedAt: 99 } } }));
            });
            expect(bodyRenders).toBe(renders);
            for (const ownerMetadataView of [{ ...ownerMetadata, work: { memoryEnabled: false } }, null, ownerMetadata]) {
                await act(async () => {
                    getStorage().setState(state => ({ sessions: { ...state.sessions, s1: { ...session, ownerMetadataView } } }));
                });
                const enabled = ownerMetadataView?.work.memoryEnabled === true;
                expect(screen.findHostByTestId('transcript-message-save-decision:m1') !== null).toBe(enabled);
                expect(menuHasDecision()).toBe(enabled);
            }
        } finally {
            await screen?.unmount();
            getStorage().setState(previousState, true);
        }
    });

    it('opens the exact committed answer source through the shared row and native menu entry', async () => {
        const open = vi.fn();
        const screen = await renderScreen(element('agent-text', {}, false, 'answer', false, 'Quoted answer', false, false, undefined, open, 'committed-answer'));
        const button = screen.findHostByTestId('transcript-message-secondOpinion:answer');
        expect(button).not.toBeNull();
        await act(async () => { await button!.props.onPress(); });
        expect(open).toHaveBeenCalledWith({ kind: 'session', message: {
            kind: 'session', session: { serverId, sessionId: 's1' }, messageId: 'committed-answer',
        } }, 'second_opinion');
        expect(screen.findHostByTestId('transcript-message-discuss:answer')).not.toBeNull();
        const menu = screen.findAllByType(ContextMenu)[0];
        expect(menu?.props.items.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining(['secondOpinion', 'discuss']));
        await act(async () => { await menu!.props.onSelect('discuss'); });
        expect(open).toHaveBeenLastCalledWith({ kind: 'session', message: {
            kind: 'session', session: { serverId, sessionId: 's1' }, messageId: 'committed-answer',
        } }, 'discuss');
        await screen.update(element('agent-text', {}, false, 'thinking', false, 'Thinking', false, true, undefined, open));
        expect(screen.findHostByTestId('transcript-message-secondOpinion:thinking')).toBeNull();
        expect(home.requestsFor('/v1/discussions/second-opinion/preview')).toHaveLength(0);
    });

    it('clears copied feedback after a refused retry and lets the message copy succeed again', async () => {
        const Clipboard = await import('expo-clipboard');
        const { Modal } = await import('@/modal');
        const { Icon } = await import('@/components/ui/icons/Icon');
        const screen = await renderScreen(element('agent-text', { transcriptMessageMakeRepeatableActionEnabled: false }));
        const glyph = () => screen.findHostByTestId('transcript-message-copy:m1-icon')!.findByType(Icon).props.name;
        const pressCopy = async () => {
            const button = screen.findHostByTestId('transcript-message-copy:m1');
            if (!button) throw new Error('Missing message copy action');
            await act(async () => { await button.props.onPress(); });
        };
        expect(glyph()).toBe('copy');
        await pressCopy();
        expect(glyph()).toBe('check');

        vi.mocked(Modal.alert).mockClear();
        vi.mocked(Clipboard.setStringAsync).mockResolvedValueOnce(false);
        await pressCopy();
        expect(Modal.alert).toHaveBeenCalledOnce();
        expect(glyph()).toBe('copy');

        await pressCopy();
        expect(glyph()).toBe('check');
        await screen.update(element('agent-text', { transcriptMessageMakeRepeatableActionEnabled: false }, false, 'm1', false, 'Changed message text'));
        expect(glyph()).toBe('copy');
        await pressCopy();
        expect(glyph()).toBe('check');
        await screen.update(element('agent-text', { transcriptMessageMakeRepeatableActionEnabled: false }, false, 'recycled', false, 'Changed message text'));
        expect(screen.findHostByTestId('transcript-message-copy:recycled-icon')!.findByType(Icon).props.name).toBe('copy');
    });

    it.each(['android', 'ios'] as const)('keeps the %s message passive while native hold and child copy stay usable', async (platform) => {
        platformState.os = platform;
        const Clipboard = await import('expo-clipboard');
        const screen = await renderScreen(element('agent-text', { transcriptMessageMakeRepeatableActionEnabled: false }));
        const body = screen.findHostByTestId('committed-message-body')!;
        for (let ancestor = body.parent; ancestor; ancestor = ancestor.parent) {
            expect(typeof ancestor.type === 'string' && String(ancestor.type) === 'Pressable').toBe(false);
        }
        const detector = screen.findAllByType('GestureDetector')[0];
        expect(detector).toBeDefined();
        const hold = detector.props.gesture as TestGestureChain;
        expect(hold.__kind).toBe('longPress');
        expect(hold.__config.enabled).toBe(true);
        expect(screen.findAllByType(ContextMenu)[0]?.props.open).toBe(false);
        await act(async () => { hold.__handlers.onStart(); });
        expect(screen.findAllByType(ContextMenu)[0]?.props.open).toBe(true);
        const copy = screen.findHostByTestId('transcript-message-copy:m1');
        if (!copy) throw new Error('Missing child copy action');
        vi.mocked(Clipboard.setStringAsync).mockClear();
        await act(async () => { await copy.props.onPress(); });
        expect(Clipboard.setStringAsync).toHaveBeenCalledWith('Useful prompt');
        const identity = body.props.accessibilityLabel;
        await screen.update(element('agent-text', {
            transcriptMessageCopyActionEnabled: false, transcriptMessageForkActionEnabled: false,
            transcriptMessageRollbackActionEnabled: false, transcriptMessageSelectionEnabled: false,
            transcriptMessagePinActionEnabled: false, transcriptMessageSavePromptActionEnabled: false,
            transcriptMessageMakeRepeatableActionEnabled: false, transcriptMessagePluginActionsEnabled: false,
        }));
        expect((screen.findAllByType('GestureDetector')[0]?.props.gesture as TestGestureChain).__config.enabled).toBe(false);
        expect(screen.findHostByTestId('committed-message-body')?.props.accessibilityLabel).toBe(identity);
    });

    it('keeps web message content passive while hover tracking and child copy stay usable', async () => {
        platformState.os = 'web';
        const onPointerEnter = vi.fn();
        const onPointerLeave = vi.fn();
        const initial = element('agent-text', { transcriptMessageMakeRepeatableActionEnabled: false }, false, 'm1', false, 'Useful prompt', false, false, { onPointerEnter, onPointerLeave });
        const screen = await renderScreen(initial);
        const body = screen.findHostByTestId('committed-message-body')!;
        for (let ancestor = body.parent; ancestor; ancestor = ancestor.parent) {
            expect(typeof ancestor.type === 'string' && String(ancestor.type) === 'Pressable').toBe(false);
        }
        let wrapper = body.parent;
        while (wrapper && !(typeof wrapper.type === 'string' && typeof wrapper.props.onPointerEnter === 'function')) wrapper = wrapper.parent;
        if (!wrapper) throw new Error('Missing web hover host');
        await act(async () => { wrapper.props.onPointerEnter(); wrapper.props.onPointerLeave(); });
        expect(onPointerEnter).toHaveBeenCalledOnce();
        expect(onPointerLeave).toHaveBeenCalledOnce();
        expect(screen.findAllByType('GestureDetector')).toHaveLength(0);
        const Clipboard = await import('expo-clipboard');
        const copy = screen.findHostByTestId('transcript-message-copy:m1');
        if (!copy) throw new Error('Missing child copy action');
        vi.mocked(Clipboard.setStringAsync).mockClear();
        await act(async () => { await copy.props.onPress(); });
        expect(Clipboard.setStringAsync).toHaveBeenCalledWith('Useful prompt');
    });

    it('does not republish an unavailable workflow capability into a second message-body render', async () => {
        const features = createRootLayoutFeaturesResponse();
        features.features.workflows.enabled = false;
        home.answer(serverId, '/v1/features', { body: features });
        home.answer(serverId, '/v1/features/authenticated', { body: features });
        await featuresClient.getServerFeaturesSnapshot({ serverId, force: true });
        const screen = await renderScreen(element('agent-text'));
        expect(screen.findHostByTestId('transcript-message-repeatable:m1')).toBeNull();
        expect(screen.findAllByType(ContextMenu)[0]?.props.items.some((item: { id: string }) => item.id === 'makeRepeatable')).toBe(false);
        expect(bodyRenders).toBe(1);
    });

    it('subscribes only while Make repeatable is eligible, preserving a view-only recycled body and row/menu parity', async () => {
        const off = { transcriptMessageMakeRepeatableActionEnabled: false };
        const screen = await renderScreen(element('agent-text', off));
        const bodyIdentity = screen.findHostByTestId('committed-message-body')?.props.accessibilityLabel;
        const menu = () => screen.findAllByType(ContextMenu)[0]?.props.items ?? [];
        expect(activeFeatureSubscriptions).toBe(0);
        expect(screen.findHostByTestId('transcript-message-repeatable:m1')).toBeNull();
        await screen.update(element('agent-text'));
        expect(screen.findHostByTestId('transcript-message-repeatable:m1')).not.toBeNull();
        expect(menu().some((item: { id: string }) => item.id === 'makeRepeatable')).toBe(true);
        expect(activeFeatureSubscriptions).toBeGreaterThan(0);
        await screen.update(element('agent-text', off));
        expect(screen.findHostByTestId('transcript-message-repeatable:m1')).toBeNull();
        expect(menu().some((item: { id: string }) => item.id === 'makeRepeatable')).toBe(false);
        expect(activeFeatureSubscriptions).toBe(0);
        await screen.update(element('agent-text', off, false, 'recycled'));
        expect(screen.findHostByTestId('transcript-message-repeatable:recycled')).toBeNull();
        await screen.update(element('agent-text', {}, false, 'recycled'));
        expect(screen.findHostByTestId('transcript-message-repeatable:recycled')).not.toBeNull();
        for (const next of [
            element('agent-text', {}, false, 'thinking', false, 'Thinking', false, true),
            element('user-text', {}, false, 'user'),
            element('agent-text', {}, true, 'structured'),
            element('agent-text', {}, false, 'empty', false, '   '),
        ]) {
            await screen.update(next);
            expect(activeFeatureSubscriptions).toBe(0);
            expect(menu().some((item: { id: string }) => item.id === 'makeRepeatable')).toBe(false);
            expect(screen.findHostByTestId('committed-message-body')?.props.accessibilityLabel).toBe(bodyIdentity);
        }
    });

    it('leaves no committed actions when all switches are off, even with workflow eligibility', async () => {
        const screen = await renderScreen(element('agent-text', {
            transcriptMessageCopyActionEnabled: false, transcriptMessageForkActionEnabled: false,
            transcriptMessageRollbackActionEnabled: false, transcriptMessageSelectionEnabled: false,
            transcriptMessagePinActionEnabled: false, transcriptMessageSavePromptActionEnabled: false,
            transcriptMessageMakeRepeatableActionEnabled: false, transcriptMessagePluginActionsEnabled: false,
        }));
        expect(screen.findAllByType(ContextMenu)).toHaveLength(0);
        expect(screen.findHostByTestId('transcript-message-repeatable:m1')).toBeNull();
    });

    it.each([
        ['copy', 'transcriptMessageCopyActionEnabled'], ['fork', 'transcriptMessageForkActionEnabled'],
        ['rollback', 'transcriptMessageRollbackActionEnabled'], ['select', 'transcriptMessageSelectionEnabled'],
        ['pin', 'transcriptMessagePinActionEnabled'], ['savePrompt', 'transcriptMessageSavePromptActionEnabled'],
    ] as const)('%s disappears from mounted/recycled rows and menus when off', async (id, setting) => {
        const testSuffix = id === 'savePrompt' ? 'save-prompt' : id;
        for (const [kind, structured] of [['user-text', false], ['user-text', true], ['agent-text', false]] as const) {
            if (id === 'savePrompt' && (structured || kind === 'agent-text')) continue;
            const screen = await renderScreen(element(kind, {}, structured));
            expect(screen.findHostByTestId(`transcript-message-${testSuffix}:m1`) !== null).toBe(true);
            expect(screen.findAllByType(ContextMenu)[0].props.items.some((item: { id: string }) => item.id === id)).toBe(true);
            await screen.update(element(kind, { [setting]: false }, structured));
            expect(screen.findHostByTestId(`transcript-message-${testSuffix}:m1`) === null).toBe(true);
            expect(screen.findAllByType(ContextMenu)[0].props.items.some((item: { id: string }) => item.id === id)).toBe(false);
            await screen.update(element(kind, { [setting]: false }, structured, 'recycled'));
            expect(screen.findHostByTestId(`transcript-message-${testSuffix}:recycled`) === null).toBe(true);
            await screen.unmount();
        }
    });

    it('keeps an existing pin removable with the Pin preference off', async () => {
        const screen = await renderScreen(element('agent-text', { transcriptMessagePinActionEnabled: false }, false, 'm1', true));
        expect(screen.findHostByTestId('transcript-message-pin:m1')?.props.accessibilityLabel).toBe('session.transcriptNavigation.unpinMessageA11y');
        expect(screen.findAllByType(ContextMenu)[0].props.items.some((item: { id: string }) => item.id === 'pin')).toBe(false);
    });

    it('does not offer Save for assistant or structured-only text', async () => {
        const screen = await renderScreen(element('agent-text'));
        expect(screen.findHostByTestId('transcript-message-save-prompt:m1') === null).toBe(true);
        await screen.update(element('user-text', {}, true));
        expect(screen.findHostByTestId('transcript-message-save-prompt:m1') === null).toBe(true);
    });

    it.each(['   ', '[attachments]\nfile\n[/attachments]'])('does not offer Save for empty or attachment-only text', async (text) => {
        const screen = await renderScreen(element('user-text', {}, false, 'm1', false, text));
        expect(screen.findHostByTestId('transcript-message-save-prompt:m1')).toBeNull();
    });

    it('does not save an unsupported-content placeholder as a prompt', async () => {
        const screen = await renderScreen(element('user-text', {}, false, 'm1', false, 'Useful prompt', true));
        expect(screen.findHostByTestId('transcript-message-save-prompt:m1')).toBeNull();
    });

    it('removes plugin row and long-press actions on mounted and recycled rows', async () => {
        const contribution: PluginProjectionEntry = {
            pluginId: 'acme.preview', title: 'Preview', description: null, version: '1.0.0', enabled: true,
            generation: 7, generationLabel: '7', status: null, provenance: null, diagnostics: [], resources: [], editableSettingsGroups: [],
            actions: [{ id: 'preview', occurrenceId: null, title: 'Preview', description: null, icon: null,
                scopes: ['message'], surfaces: ['ui'], placementBindings: ['rowAction', 'message.menu'],
                inputHints: null, priority: null, dangerLevel: 'safe', confirmation: null, available: true }],
        };
        const host = createPluginMessageActionHost({ sessionId: 's1', resolveCurrent: () => ({
            pluginProjectionById: { 'acme.preview': contribution }, host: { machineId: 'machine-1', serverId: 'server-a',
                expectedContributorOccurrenceId: 7, sessionId: 's1', isCurrent: () => true },
        }) });
        const row = (enabled: boolean, id = 'm1') => <PluginMessageActionHostProvider host={host}>
            {element('user-text', { transcriptMessagePluginActionsEnabled: enabled }, false, id)}
        </PluginMessageActionHostProvider>;
        const screen = await renderScreen(row(true));
        expect(screen.findHostByTestId('plugin-message-action:acme.preview/preview')).not.toBeNull();
        expect(screen.findAllByType(ContextMenu)[0].props.items.some((item: { id: string }) => item.id === 'plugin:acme.preview/preview')).toBe(true);
        await screen.update(row(false));
        expect(screen.findHostByTestId('plugin-message-action:acme.preview/preview')).toBeNull();
        expect(screen.findAllByType(ContextMenu)[0].props.items.some((item: { id: string }) => item.id === 'plugin:acme.preview/preview')).toBe(false);
        await screen.update(row(false, 'recycled'));
        expect(screen.findHostByTestId('plugin-message-action:acme.preview/preview')).toBeNull();
    });
});

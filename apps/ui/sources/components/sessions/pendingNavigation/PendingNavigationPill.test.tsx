import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, createSessionMessagesFixture, createToolCallMessageFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { clearPendingNavigationState, markSessionPendingAnswer, registerPendingNavigationRuntime } from '@/activity/source/pendingNavigationRuntime';
import { PendingAttentionPill, PendingNavigationPill } from './PendingNavigationPill';

// Native viewport APIs are the boundary; responsive classification stays real.
const device = vi.hoisted(() => ({ width: 1440, height: 900 }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Dimensions: { get: () => ({ ...device, scale: 1, fontScale: 1 }), addEventListener: () => ({ remove() {} }) },
    useWindowDimensions: () => ({ ...device, scale: 1, fontScale: 1 }),
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

const address = { serverId: 'home-a', sessionId: 'same' };
const initialState = storage.getState();
let unregister: (() => void) | undefined;

function seedWaitingSessions() {
    const now = Date.now();
    const current = createSessionFixture({ id: 'same', serverId: 'home-a', active: true, activeAt: now, updatedAt: now, agentState: {
        requests: { question: { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: now } },
    } });
    const other = createSessionFixture({ ...current, serverId: 'home-b' });
    const readOnly = createSessionFixture({ ...current, id: 'read-only', access: {
        ...current.access!, capabilities: { ...current.access!.capabilities, submitAgentInput: false, approveRuntimePermissions: false },
    } });
    storage.setState({
        isDataReady: true,
        sessions: { same: current, 'read-only': readOnly },
        sessionListRowsByServerId: {
            'home-a': { same: buildSessionListRenderableFromSession(current), 'read-only': buildSessionListRenderableFromSession(readOnly) },
            'home-b': { same: buildSessionListRenderableFromSession(other) },
        },
        ordinarySessionListMembershipByServerId: { 'home-a': ['same', 'read-only'], 'home-b': ['same'] },
        sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {},
    });
}

describe('PendingNavigationPill', () => {
    beforeEach(seedWaitingSessions);
    afterEach(() => {
        device.width = 1440;
        device.height = 900;
        standardCleanup();
        unregister?.();
        unregister = undefined;
        clearPendingNavigationState();
        storage.setState(initialState, true);
        vi.useRealTimers();
    });

    it('counts the same session in another Home and invokes Next with the exact current address', async () => {
        const navigate = vi.fn(async () => ({ status: 'opened' as const }));
        unregister = registerPendingNavigationRuntime(navigate);
        const screen = await renderScreen(<PendingNavigationPill address={address} presentation="header" />);
        expect(screen.findByTestId('pending-navigation-header')).not.toBeNull();
        expect(screen.findByTestId('pending-navigation-header-count')?.props.children).toBe('1 needs you');
        await screen.pressByTestIdAsync('pending-navigation-header');
        expect(navigate).toHaveBeenCalledWith({ excluding: address });
    });

    it('yields to the session title in a tight header: the count alone, still the same Next', async () => {
        const navigate = vi.fn(async () => ({ status: 'opened' as const }));
        unregister = registerPendingNavigationRuntime(navigate);
        const { DetailsTabHeaderActionsCompactContext } = await import('@/components/appShell/panes/details/header/DetailsTabHeader');
        const screen = await renderScreen(<DetailsTabHeaderActionsCompactContext.Provider value={true}>
            <PendingNavigationPill address={address} presentation="header" />
        </DetailsTabHeaderActionsCompactContext.Provider>);
        expect(screen.findByTestId('pending-navigation-header-count')?.props.children).toBe('1');
        expect(screen.findByTestId('pending-navigation-header')?.props.accessibilityLabel).toContain('1 needs you');
        await screen.pressByTestIdAsync('pending-navigation-header');
        expect(navigate).toHaveBeenCalledWith({ excluding: address });
    });

    it('shows one count on a phone: the session nav capsule, not a second header pill', async () => {
        device.width = 390;
        device.height = 844;
        const header = await renderScreen(<PendingNavigationPill address={address} presentation="header" />);
        expect(header.findByTestId('pending-navigation-header')).toBeNull();
        const phone = await renderScreen(<PendingNavigationPill address={address} presentation="phone" />);
        expect(phone.findByTestId('pending-navigation-phone')).not.toBeNull();
    });

    // The phone capsule sits flush between two session nav tabs: a finger's hit area grows up and down
    // into the bar, never sideways into the tabs beside it.
    it('keeps the phone capsule\'s hit area off the session nav tabs it sits between', async () => {
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
        const screen = await renderScreen(
            <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
                <PendingAttentionPill count={2} phone shortcut={undefined} onPress={() => {}} />
            </HappierUiPlatformProvider>,
        );
        await act(async () => {
            screen.findByTestId('pending-navigation-phone')?.props.onLayout({ nativeEvent: { layout: { width: 34, height: 26 } } });
        });
        // The web hit area is an invisible absolute frame inside the capsule, offset by its reach on each side.
        const pill = screen.findByTestId('pending-navigation-phone')!;
        const frame = pill.findAll((node) => node.props?.['aria-hidden'] === true && node.props?.style?.position === 'absolute')[0];
        const reach = { top: -frame!.props.style.top, bottom: -frame!.props.style.bottom, left: -frame!.props.style.left, right: -frame!.props.style.right };
        expect(reach.left).toBe(0);
        expect(reach.right).toBe(0);
        expect(reach.top + 26 + reach.bottom).toBe(44);
    });

    it('does not rerender the header for unrelated messages or composer settings', async () => {
        let commits = 0;
        await renderScreen(<React.Profiler id="pending-header" onRender={() => { commits += 1; }}>
            <PendingNavigationPill address={address} presentation="header" />
        </React.Profiler>);
        const baseline = commits;
        await act(async () => {
            storage.setState((state) => ({
                sessionMessages: { ...state.sessionMessages, same: createSessionMessagesFixture({
                    messageIdsOldestFirst: ['unrelated-message'],
                    messagesById: { 'unrelated-message': createToolCallMessageFixture({ id: 'unrelated-message' }) },
                    messagesVersion: 1, isLoaded: true,
                }) },
                settings: { ...state.settings, agentInputEnterToSend: !state.settings.agentInputEnterToSend },
            }));
        });
        expect(commits).toBe(baseline);
    });

    it('offers Next after an answer only in the answered Home and hides when nothing else waits', async () => {
        const screen = await renderScreen(<PendingNavigationPill address={address} presentation="composer" />);
        expect(screen.findByTestId('pending-navigation-composer')).toBeNull();
        await act(async () => { markSessionPendingAnswer({ serverId: 'home-b', sessionId: 'same' }, 'question'); });
        expect(screen.findByTestId('pending-navigation-composer')).toBeNull();
        await act(async () => { markSessionPendingAnswer(address, 'question'); });
        expect(screen.findByTestId('pending-navigation-composer')).not.toBeNull();
        await act(async () => { storage.setState({ sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {} }); });
        expect(screen.findByTestId('pending-navigation-composer')).toBeNull();
    });

    it('names the one waiting session and what it waits on, and Not now dismisses it until the next answer', async () => {
        const screen = await renderScreen(<PendingNavigationPill address={address} presentation="composer" />);
        await act(async () => { markSessionPendingAnswer(address, 'question'); });
        expect(screen.findByTestId('pending-navigation-composer')).not.toBeNull();
        expect(screen.findAll((node) => node.props?.children === 'is waiting for your answer').length).toBeGreaterThan(0);
        await screen.pressByTestIdAsync('pending-navigation-composer-dismiss');
        expect(screen.findByTestId('pending-navigation-composer')).toBeNull();
        await act(async () => { markSessionPendingAnswer(address, 'question-2'); });
        expect(screen.findByTestId('pending-navigation-composer')).not.toBeNull();
    });

    it('leaves by itself once you type in this composer (lab fnext N1a), and returns with the next answer', async () => {
        const { createComposerTextStore } = await import('@/components/sessions/agentInput/composerTextStore');
        const composerText = createComposerTextStore('');
        const screen = await renderScreen(<PendingNavigationPill address={address} presentation="composer" composerText={composerText} />);
        await act(async () => { markSessionPendingAnswer(address, 'question'); });
        expect(screen.findByTestId('pending-navigation-composer')).not.toBeNull();
        await act(async () => { composerText.setPrompt('Also check the footer'); });
        expect(screen.findByTestId('pending-navigation-composer')).toBeNull();
        await act(async () => { markSessionPendingAnswer(address, 'question-2'); });
        expect(screen.findByTestId('pending-navigation-composer')).not.toBeNull();
    });

    it('keeps legacy user-action attention without an expiry clock until its runtime clears the request', async () => {
        vi.useFakeTimers();
        const now = 1_700_000_000_000;
        vi.setSystemTime(now);
        const session = createSessionFixture({
            id: 'legacy', serverId: 'home-b', viewer: undefined, active: true, presence: 'online',
            createdAt: now - 1_000, updatedAt: now - 1_000, activeAt: now - 1_000,
            agentState: { requests: { question: { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: now - 1_000 } } },
        });
        storage.setState({ sessions: {}, sessionListRowsByServerId: { 'home-b': { legacy: buildSessionListRenderableFromSession(session) } },
            ordinarySessionListMembershipByServerId: { 'home-b': ['legacy'] } });
        const timersBeforeMount = vi.getTimerCount();
        const screen = await renderScreen(<PendingNavigationPill address={address} presentation="header" />);
        expect(screen.findByTestId('pending-navigation-header')).not.toBeNull();
        expect(vi.getTimerCount()).toBe(timersBeforeMount);
        await act(async () => { await vi.advanceTimersByTimeAsync(121_000); });
        expect(screen.findByTestId('pending-navigation-header')).not.toBeNull();
        await act(async () => {
            storage.setState({ sessionListRowsByServerId: { 'home-b': {
                legacy: buildSessionListRenderableFromSession({ ...session, agentState: { requests: {} } }),
            } } });
        });
        expect(screen.findByTestId('pending-navigation-header')).toBeNull();
    });

    it('keeps modern viewer attention until its Home updates it, and reacts to grant revocation', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        const session = createSessionFixture({ id: 'modern', serverId: 'home-b', active: true, viewer: {
            latestFailureSeq: null,
            readState: { state: 'not_started' }, relevance: { relevant: true, reasons: ['owned_by_me'] },
            follow: { follows: false, notificationLevel: null }, notification: { level: 'important', source: 'owner' },
            attention: { needsAttention: true, reasons: ['user_action_required'], primary: 'user_action_required', presentation: 'full' },
        } });
        storage.setState({ sessions: {}, sessionListRowsByServerId: { 'home-b': { modern: buildSessionListRenderableFromSession(session) } },
            ordinarySessionListMembershipByServerId: { 'home-b': ['modern'] } });
        const screen = await renderScreen(<PendingNavigationPill address={address} presentation="phone" />);
        expect(screen.findByTestId('pending-navigation-phone')).not.toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(121_000); });
        expect(screen.findByTestId('pending-navigation-phone')).not.toBeNull();
        const revoked = { ...session, access: { ...session.access!, capabilities: {
            ...session.access!.capabilities, submitAgentInput: false, approveRuntimePermissions: false,
        } } };
        await act(async () => { storage.setState({ sessionListRowsByServerId: { 'home-b': { modern: buildSessionListRenderableFromSession(revoked) } } }); });
        expect(screen.findByTestId('pending-navigation-phone')).toBeNull();
    });
});

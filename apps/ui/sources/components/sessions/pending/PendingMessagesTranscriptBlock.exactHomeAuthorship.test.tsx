import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture, createSessionListRenderableSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { SessionMessageAccountActorV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageAccountActorV1';
import { serveSessionActionHome } from '@/dev/testkit/harness/sessionActionHome';
import { t } from '@/text';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SHARED_SESSION_ID = 'shared-session';
let home: Awaited<ReturnType<typeof serveSessionActionHome>>;
let homeA: string;
let homeB: string;

/**
 * Two Homes whose Sessions share one raw Session ID, with different viewer
 * Accounts and a different named-collaborator audience. Only the exact Home the
 * transcript was opened for may decide the pending/discarded bylines.
 */
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

vi.mock('./PendingMessagesDragReorderList', () => ({
    PendingMessagesDragReorderList: (props: any) => {
        const children = Array.isArray(props.messages)
            ? props.messages.map((m: any, index: number) =>
                props.renderItem({
                    message: m,
                    index,
                    isDragging: false,
                    renderDragHandle: ({ testID, accessibilityLabel }: { testID?: string; accessibilityLabel?: string }) => React.createElement('View', { testID, accessibilityLabel }),
                }),
            )
            : null;
        return React.createElement('PendingMessagesDragReorderList', props, children);
    },
}));

vi.mock('@/components/markdown/MarkdownView', () => ({ MarkdownView: 'MarkdownView' }));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement(
        'DropdownMenu',
        null,
        typeof props.trigger === 'function'
            ? props.trigger({ open: false, openMenu: () => {}, closeMenu: () => {}, toggle: () => {}, selectedItem: null })
            : props.trigger ?? null,
    ),
}));
vi.mock('@/components/ui/scroll/ScrollEdgeFades', () => ({ ScrollEdgeFades: () => null }));
vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({ ScrollEdgeIndicators: () => null }));
vi.mock('@/components/ui/scroll/useScrollEdgeFades', () => ({
    useScrollEdgeFades: () => ({
        canScrollX: false,
        canScrollY: false,
        visibility: { top: false, bottom: false, left: false, right: false },
        onViewportLayout: () => {},
        onContentSizeChange: () => {},
        onScroll: () => {},
    }),
}));
vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 800, headerMaxWidth: 800 },
    useLayoutMaxWidth: () => 800,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 800 }),
}));

function actor(serverId: string, accountId: string, firstName: string) {
    return {
        serverId,
        ...SessionMessageAccountActorV1Schema.parse({
            v: 1,
            accountId,
            profile: { firstName, lastName: null, username: accountId, avatarUrl: null },
        }),
    };
}

function pending(id: string, authorServerId: string, authorAccountId: string, name: string) {
    return {
        id,
        localId: id,
        text: `text-${id}`,
        displayText: undefined,
        createdAt: 0,
        updatedAt: 0,
        rawRecord: {},
        accountActor: actor(authorServerId, authorAccountId, name),
    };
}

describe('pending queue authorship is decided by the exact Home', () => {
    beforeEach(async () => {
        // The last served Home is active. Both Homes serve real Profile and
        // Settings responses and bind their Accounts through TokenStorage.
        home = await serveSessionActionHome({
            homes: [
                { key: 'b', serverUrl: 'https://home-b.example.test', accountId: 'bob', profile: { name: 'Bob' } },
                { key: 'a', serverUrl: 'https://home-a.example.test', accountId: 'alice', profile: { name: 'Alice' } },
            ],
            route: () => undefined,
        });
        homeA = home.homes.a!.id;
        homeB = home.homes.b!.id;
        const { storage } = await import('@/sync/domains/state/storageStore');
        // The private record belongs to active Home A; Home B's row with the
        // same raw Session ID is published by the real qualified listing owner.
        storage.getState().applySessions([createSessionFixture({
            id: SHARED_SESSION_ID,
            serverId: homeA,
            hasOtherNamedCollaborator: false,
        })]);
        storage.getState().applyServerScopedSessionListRows(homeB, [createSessionListRenderableSessionFixture({
            id: SHARED_SESSION_ID, hasOtherNamedCollaborator: true,
        })], { source: 'rowOnly', mode: 'replace' });
    });

    afterEach(async () => {
        await standardCleanup();
        await home.dispose();
    });

    it('names the selected Home\'s viewer on pending and discarded bylines, not the active Home\'s', async () => {
        const { PendingMessagesTranscriptBlock } = await import('./PendingMessagesTranscriptBlock');
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: SHARED_SESSION_ID,
            serverId: homeB,
            pendingMessages: [pending('p1', homeB, 'bob', 'Bob')] as never,
            discardedMessages: [pending('d1', homeB, 'bob', 'Bob')] as never,
        }));

        // Bob is the viewer in Home B, so both rows read as "You"; the byline is
        // painted at all only because Home B's audience has another named human.
        await vi.waitFor(() => expect(screen.findByTestId('transcript-account-attribution:p1')?.props.children)
            .toBe(t('message.accountActorYou')));
        expect(screen.findByTestId('transcript-account-attribution:d1')?.props.children)
            .toBe(t('message.accountActorYou'));
        const queue = screen.findByType('PendingMessagesDragReorderList');
        expect(queue.props.scope).toEqual({ serverId: homeB, accountId: 'bob' });
        expect(queue.props.sessionId).toBe(SHARED_SESSION_ID);
        expect(queue.props.recipient).toBeNull();
    });

    it('keeps the other Home\'s collaborator a named person rather than the viewer', async () => {
        const { PendingMessagesTranscriptBlock } = await import('./PendingMessagesTranscriptBlock');
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: SHARED_SESSION_ID,
            serverId: homeB,
            pendingMessages: [pending('p2', homeB, 'alice', 'Alice')] as never,
            discardedMessages: [],
        }));

        await vi.waitFor(() => expect(screen.findByTestId('transcript-account-attribution:p2')?.props.children).toBe('Alice'));
    });

    it('suppresses a self byline in a solo Session of the selected Home', async () => {
        const { PendingMessagesTranscriptBlock } = await import('./PendingMessagesTranscriptBlock');
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: SHARED_SESSION_ID,
            serverId: homeA,
            pendingMessages: [pending('p3', homeA, 'alice', 'Alice')] as never,
            discardedMessages: [],
        }));

        await vi.waitFor(() => expect(screen.findByType('PendingMessagesDragReorderList').props.scope)
            .toEqual({ serverId: homeA, accountId: 'alice' }));
        expect(screen.findByTestId('transcript-account-attribution:p3')).toBeNull();
    });
});

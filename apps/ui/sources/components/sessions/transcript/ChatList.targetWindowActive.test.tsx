import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    chatListHarnessState, renderChatList, requireCapturedLegendListProps, resetChatListHarness,
    triggerLegendChatListInitialFill, triggerLegendChatListScroll,
} from '@/dev/testkit/harness/chatListHarness';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';

vi.mock('react-native', async () =>
    (await import('@/dev/testkit/harness/chatListHarness')).createChatListHarnessReactNativeMock({ platformOs: 'ios' }));
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () =>
    (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('@/modal', async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

vi.mock('@legendapp/list/react-native', async (importOriginal) => ({
    ...await importOriginal<typeof import('@legendapp/list/react-native')>(),
    ...(await import('@/dev/testkit/harness/chatListHarness')).createLegendChatListModuleMock(),
}));

vi.mock('react-native-safe-area-context', () => ({
    initialWindowMetrics: null,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

await initializeRealAppRuntimeForTests();
const { sync } = await import('@/sync/sync');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { ChatList } = await import('./ChatList');

const sessionId = 'session-target-window';
const serverId = 'srv_target_window';
const newestSeq = 60;
let home: Awaited<ReturnType<typeof serveAccountHomes>> | null = null;
const messageRequests: URL[] = [];

function plainMessage(seq: number) {
    return {
        id: `message-${seq}`, seq, localId: null, sidechainId: null,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `Message ${seq}` } } },
        createdAt: seq, updatedAt: seq,
    };
}

beforeEach(async () => {
    messageRequests.length = 0;
    resetChatListHarness({ platformOs: 'ios' });
    const session = createSessionFixture({ id: sessionId, serverId, active: true, seq: newestSeq });
    const sessions = createSessionMetadataHttpBoundary(() => ({ [sessionId]: session }));
    home = await serveAccountHomes({
        homes: [{ key: 'home', serverUrl: 'https://target-window.test', serverIdentityId: serverId,
            accountId: 'viewer-account', settings: {
                transcriptGroupingMode: 'linear', transcriptMotionPreset: 'off', transcriptScrollPinOffsetThresholdPx: 72,
            } }],
        route: ({ path, url }) => {
            if (path === `/v1/sessions/${sessionId}/messages`) {
                messageRequests.push(url);
                if (url.searchParams.get('beforeSeq') === '21') return Response.json({
                    messages: [plainMessage(20), plainMessage(19)], hasMore: true, nextBeforeSeq: 19,
                });
                if (url.searchParams.get('beforeSeq') === '19') return Response.json({
                    messages: [plainMessage(18)], hasMore: false, nextBeforeSeq: 18,
                });
                const newerMessages = Array.from({ length: newestSeq - 20 }, (_, index) => plainMessage(21 + index));
                if (url.searchParams.has('afterSeq')) return Response.json({
                    messages: newerMessages.filter(message => message.seq > Number(url.searchParams.get('afterSeq'))),
                    hasMore: false, nextAfterSeq: newestSeq,
                });
                return Response.json({ messages: [...newerMessages.reverse(), plainMessage(20), plainMessage(19)],
                    hasMore: true, nextBeforeSeq: 19 });
            }
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
            if (path === '/v1/account/project-rows/list') return Response.json(createPlainProjectAccountRowListFixture());
            if (path === '/v1/artifacts' || path === '/v1/machines') return Response.json([]);
            return sessions.handle(url) ?? undefined;
        },
    });
    expect(await sync.ensureSessionVisibleForMessageRoute(sessionId, {
        serverId, forceRefresh: true, awaitMessageHydration: true,
    })).toMatchObject({ kind: 'available' });
    expect(await sync.loadTargetWindowMessages(sessionId, { kind: 'seq', seq: 20 })).toMatchObject({
        status: 'loaded', targetPresent: true, olderCursor: 19, hasMoreOlder: true, hasMoreNewer: false,
    });
    chatListHarnessState.sessionState = getStorage().getState().sessions[sessionId];
    vi.useFakeTimers();
    if (typeof globalThis.requestAnimationFrame !== 'function') {
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0));
        vi.stubGlobal('cancelAnimationFrame', (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
    }
});

afterEach(async () => {
    standardCleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    await home?.dispose();
    home = null;
    vi.unstubAllGlobals();
});

async function renderAtBottom() {
    const screen = await renderChatList(<ChatList
        session={chatListHarnessState.sessionState}
        sessionSurfaceKey={sessionAddressKey({ serverId, sessionId })}
    />);
    // A two-row viewport is already inside the real item-prefetch threshold even
    // at the bottom. Serve a longer newer side and measure its bottom viewport so
    // the older frontier remains untouched until this test reaches that edge.
    const rowCount = requireCapturedLegendListProps().data.length;
    const rowHeight = 60;
    const layoutHeight = 600;
    const contentHeight = rowCount * rowHeight;
    const scroll = contentHeight - layoutHeight;
    const start = Math.floor(scroll / rowHeight);
    await triggerLegendChatListInitialFill(screen, { contentHeight, layoutHeight,
        state: { scroll, start, end: rowCount - 1, startBuffered: start - 2, endBuffered: rowCount - 1,
            positionAtIndex: index => index * rowHeight, sizeAtIndex: () => rowHeight },
        flushOptions: { advanceTimersMs: 0, cycles: 1, turns: 1 } });
    await act(async () => {
        const list = requireCapturedLegendListProps();
        // The transcript adapter synthesizes content size from Legend's measured
        // state on load; Legend itself has no onContentSizeChange callback.
        list.onLoad?.({ elapsedTimeInMs: 12 });
    });
    await triggerLegendChatListScroll(scroll, {
        contentSize: { width: 400, height: contentHeight }, layoutMeasurement: { width: 400, height: layoutHeight },
    }, { advanceTimersMs: 0, cycles: 1, turns: 1 });
    await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });
    expect(sync.getSessionTargetWindowState(sessionId)).toMatchObject({ olderCursor: 19, hasMoreOlder: true });
    expect(messageRequests.some(url => url.searchParams.get('beforeSeq') === '19')).toBe(false);
    messageRequests.length = 0;
    return screen;
}

describe('ChatList target-window active live-tail gating', () => {
    it('pages the active target window at the older (top) edge', async () => {
        const screen = await renderAtBottom();
        chatListHarnessState.legendListState = { ...chatListHarnessState.legendListState,
            scroll: 0, start: 0, end: 9, startBuffered: 0, endBuffered: 11 };
        await act(async () => { await requireCapturedLegendListProps().onStartReached?.(); });
        await screen.settle({ advanceTimersMs: 0, cycles: 10 });

        expect(messageRequests.map(url => ({ path: url.pathname, beforeSeq: url.searchParams.get('beforeSeq') }))).toEqual([
            { path: `/v1/sessions/${sessionId}/messages`, beforeSeq: '19' },
        ]);
        expect(sync.getSessionTargetWindowState(sessionId)).toMatchObject({
            isWindowMode: true, targetSeq: 20, olderCursor: 18, hasMoreOlder: false,
        });
        expect(Object.values(getStorage().getState().sessionMessages[sessionId]!.messagesById)
            .some(message => message.seq === 18)).toBe(true);
    });

    it('exits target-window mode through live-tail intent at the newest edge when no newer pages remain', async () => {
        const screen = await renderAtBottom();
        await act(async () => { await requireCapturedLegendListProps().onEndReached?.(); });
        await screen.settle({ advanceTimersMs: 0, cycles: 10 });

        expect(sync.getSessionTargetWindowState(sessionId)).toMatchObject({ isWindowMode: false, targetSeq: null });
        expect(messageRequests.some(url => url.searchParams.get('beforeSeq') === '19')).toBe(false);
    });
});

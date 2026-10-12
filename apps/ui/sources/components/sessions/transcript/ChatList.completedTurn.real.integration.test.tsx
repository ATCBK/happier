// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installWebLockManagerMock, type WebLockManagerMockHandle } from '@/auth/storage/tokenStorage.web.testHelpers';

// The DOM integration lane needs the actual web adapter, as the other real-Legend suites do.
vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const native = await vi.importActual<typeof import('react-native')>('react-native-web');
    const mock = createReanimatedModuleMock();
    // Preserve the canonical animation boundary while rendering its host views through the DOM adapter.
    return { ...mock, View: native.View, Text: native.Text, ScrollView: native.ScrollView,
        default: { ...mock.default, View: native.View, Text: native.Text, ScrollView: native.ScrollView } };
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await installRealActionExecutorModuleLoader();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { createSessionFixture, createSessionMessagesFixture, standardCleanup } = await import('@/dev/testkit');
const { ChatList } = await import('./ChatList');
const { AppSessionTranscriptSourceProvider } = await import('./source/appSessionTranscriptSource');

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const originalScrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
type ResizeObserverRecord = Readonly<{ callback: ResizeObserverCallback; elements: Set<Element> }>;
const resizeObservers = new Set<ResizeObserverRecord>();
let webLocks: WebLockManagerMockHandle | null = null;
beforeEach(() => { webLocks = installWebLockManagerMock(); });

function flushResizeObservers(): void {
    for (const observer of resizeObservers) {
        const entries = [...observer.elements].map(target => ({
            target, contentRect: target.getBoundingClientRect(), borderBoxSize: [],
            contentBoxSize: [], devicePixelContentBoxSize: [],
        })) as ResizeObserverEntry[];
        if (entries.length) observer.callback(entries, {} as ResizeObserver);
    }
}

afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    await standardCleanup();
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection();
    storage.setState(storage.getInitialState(), true);
    await homes.reset();
    webLocks?.restore();
    webLocks = null;
    if (originalScrollToDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollToDescriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('completed connected-Agent transcript', () => {
    it.each([true, false])('renders the two-message prompt and reply without a nested layout update loop (active=%s)', async active => {
        await homes.reset();
        const serverId = await homes.addHome({ name: 'DF33', serverUrl: 'https://df33.test', accountId: 'df33-account' });
        homes.answer(serverId, '/v2/cursor', { body: { cursor: '0' } });
        const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await restoreConnectionToActiveServer({ token: homes.findByServerUrl('https://df33.test')!.token! });
        vi.useFakeTimers();
        resizeObservers.clear();
        vi.stubGlobal('ResizeObserver', class {
            private readonly record: ResizeObserverRecord;
            constructor(callback: ResizeObserverCallback) {
                this.record = { callback, elements: new Set() };
                resizeObservers.add(this.record);
            }
            observe(target: Element) {
                resizeObservers.add(this.record);
                this.record.elements.add(target);
            }
            unobserve(target: Element) { this.record.elements.delete(target); }
            disconnect() { this.record.elements.clear(); resizeObservers.delete(this.record); }
        });
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => Number(setTimeout(() => callback(Date.now()), 16)));
        vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            const viewport = this.style.overflowY === 'auto' || this.style.overflow === 'auto';
            const height = viewport ? 600 : this.querySelector('[data-testid^="transcript-message-"]') ? 96.375 : 0;
            return { x: 0, y: 0, width: 800, height, top: 0, left: 0, right: 800, bottom: height, toJSON: () => ({}) };
        });
        vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
        vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(600);
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => undefined });
        const messages: readonly Message[] = [
            { kind: 'user-text', id: 'df33-prompt', seq: 1, localId: null, createdAt: 1,
                text: 'Please reply with exactly: Ready to talk. Do not use tools or change any files.' },
            { kind: 'agent-text', id: 'df33-reply', seq: 2, localId: null, createdAt: 2,
                text: 'Ready to talk. Do not use tools or change any files.' },
        ];
        const session = createSessionFixture({ id: 'df33-session', serverId, active, activeAt: Date.now(), thinking: false });
        storage.setState({ sessions: { [session.id]: session }, sessionMessages: { [session.id]: createSessionMessagesFixture({
            messageIdsOldestFirst: messages.map(message => message.id),
            messagesById: Object.fromEntries(messages.map(message => [message.id, message])), isLoaded: true,
        }) }, profileScope: { serverId, accountId: 'df33-account' } });
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        await act(async () => {
            root?.render(<AppSessionTranscriptSourceProvider sessionId={session.id} serverId={serverId}><ChatList session={session}
                sessionSurfaceKey="df33-surface" externalControlFooter={null} /></AppSessionTranscriptSourceProvider>);
        });
        for (let pass = 0; pass < 8; pass++) {
            await act(async () => { flushResizeObservers(); await vi.runOnlyPendingTimersAsync(); });
        }
        expect(container.querySelector('[data-testid="transcript-message-df33-prompt"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="transcript-message-df33-reply"]')).not.toBeNull();
    });
});

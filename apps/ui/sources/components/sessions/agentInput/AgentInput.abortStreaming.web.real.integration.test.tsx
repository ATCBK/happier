/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';
import type { ShakeInstance } from '@/components/ui/feedback/Shaker';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

installWebLayoutBridge();
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/components/ui/forms/MultiTextInput', async () => import('@/components/ui/forms/MultiTextInput.web'));
// Select the exact web surface Metro publishes, including Happier's shim exports.
installAgentInputCommonModuleMocks({ reactNative: async () => import('@/platform/shims/reactNativeWebShim') });
// The native animation boundary uses DOM hosts here; Shaker and the action bar stay real.
vi.doMock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const mock = createReanimatedModuleMock();
    const rn = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    const hosts = { View: rn.View, ScrollView: rn.ScrollView, Text: rn.Text };
    return { ...mock, ...hosts, default: { ...mock.default, ...hosts } };
});
const { installSessionPaneRuntimeTestHarness } = await import('@/components/sessions/panes/sessionPaneRuntimeTestHarness');
const runtime = installSessionPaneRuntimeTestHarness();
const { AgentInput } = await import('./AgentInput');
const { Shaker } = await import('@/components/ui/feedback/Shaker');
const { storage, useSession, useSessionMessages } = await import('@/sync/domains/state/storage');
const { useSessionRuntimeStatusSource } = await import('@/components/sessions/shell/useSessionRuntimeStatusSource');
const { useSessionStatus, shouldShowAbortButtonForSessionState } = await import('@/utils/sessions/sessionUtils');

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = null;
    container?.remove(); container = null;
    vi.restoreAllMocks();
});

describe('composer Stop while the real Session transcript streams', () => {
    it('can give failure feedback on web without requiring a native animation module', async () => {
        const shaker = React.createRef<ShakeInstance>();
        container = document.createElement('div'); document.body.append(container); root = createRoot(container);
        await act(async () => { root!.render(<Shaker ref={shaker}><button data-testid="feedback-child" /></Shaker>); });
        const child = container.querySelector('[data-testid="feedback-child"]');
        await act(async () => { expect(() => shaker.current!.shake()).not.toThrow(); });
        expect(container.querySelector('[data-testid="feedback-child"]')).toBe(child);
    });

    it.each(['wrap', 'scroll'] as const)('retains one enabled Stop occurrence across 32 deltas (%s)', async layout => {
        Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(25, 35, 0, 18) });
        vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
        const state = storage.getState();
        const now = Date.now();
        storage.setState({
            settings: { ...state.settings, agentInputActionBarLayout: layout },
            sessions: { ...state.sessions, s1: { ...state.sessions.s1!, active: true, activeAt: now,
                thinking: true, thinkingAt: now, latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: now } },
            sessionMessages: { ...state.sessionMessages, s1: createSessionMessagesFixture({ isLoaded: true }) },
        });
        const chunk = (index: number): NormalizedMessage => ({
            id: 'stream', localId: 'stream', createdAt: now, role: 'agent', isSidechain: false,
            content: [{ type: 'text', text: `Partial answer ${index}`, uuid: 'stream', parentUUID: null }],
            meta: { happierStreamSegmentV1: { v: 1, segmentKind: 'assistant', segmentLocalId: 'stream',
                segmentState: 'streaming', startedAtMs: now, updatedAtMs: now + index } },
        });
        storage.getState().applyMessages('s1', [chunk(0)]);
        let transcriptRenders = 0;
        const onAbort = vi.fn(async () => {});
        const suggestions = async () => [];
        const kinds: React.ComponentProps<typeof AgentInput>['autocompleteKinds'] = [];
        function Composer() {
            const session = useSession('s1');
            const statusSource = useSessionRuntimeStatusSource(session);
            const status = useSessionStatus(statusSource, { subscribeToSession: false, subscribeToTranscript: false });
            return <AgentInput sessionId="s1" value="" placeholder="Message" onChangeText={() => {}}
                autocompleteKinds={kinds} autocompleteSuggestions={suggestions} onSend={() => {}}
                onAbort={onAbort} showAbortButton={status ? shouldShowAbortButtonForSessionState(status.state) : false} />;
        }
        function Transcript() {
            transcriptRenders++;
            const { messages } = useSessionMessages('s1');
            return <div data-testid="stream-text">{messages.map(message => message.kind === 'agent-text' ? message.text : '').join('')}</div>;
        }
        container = document.createElement('div'); document.body.append(container); root = createRoot(container);
        await act(async () => { root!.render(<runtime.Wrapper><Transcript /><Composer /></runtime.Wrapper>); });
        const stop = container.querySelector<HTMLButtonElement>('[data-testid="agent-input-abort"]');
        expect(stop).not.toBeNull();
        expect(container.querySelectorAll('[data-testid="agent-input-abort"]')).toHaveLength(1);
        expect(stop!.disabled).toBe(false);
        // Observe the real render function, without substituting any internal implementation.
        type RenderProbe = { type: { render: (...args: unknown[]) => React.ReactNode } };
        const shakerRender = vi.spyOn((Shaker as unknown as RenderProbe).type, 'render');
        let added = 0;
        let removed = 0;
        const observe = (records: MutationRecord[]) => {
            for (const record of records) {
                for (const node of record.addedNodes) if (node === stop || node.contains(stop)) added++;
                for (const node of record.removedNodes) if (node === stop || node.contains(stop)) removed++;
            }
        };
        const observer = new MutationObserver(observe);
        observer.observe(container, { childList: true, subtree: true });
        const initialTranscriptRenders = transcriptRenders;
        try {
            const before = await measureWebLayout(container, { viewport: { width: 800, height: 600 }, settle: replay => act(replay) });
            const initialStop = before.rect('agent-input-abort');
            expect(initialStop.width).toBeGreaterThan(0);
            expect(initialStop.height).toBeGreaterThan(0);
            expect(initialStop.receivesPointer).toBe(true);
            shakerRender.mockClear();
            for (let index = 1; index <= 32; index++) {
                await act(async () => { storage.getState().applyMessages('s1', [chunk(index)]); });
                expect(container.querySelector('[data-testid="agent-input-abort"]')).toBe(stop);
                expect(stop!.disabled).toBe(false);
            }
            observe(observer.takeRecords());
            expect(container.querySelector('[data-testid="stream-text"]')?.textContent).toBe('Partial answer 32');
            expect(transcriptRenders - initialTranscriptRenders).toBe(32);
            expect({ added, removed, stopRenders: shakerRender.mock.calls.length }).toEqual({ added: 0, removed: 0, stopRenders: 0 });
            const after = await measureWebLayout(container, { viewport: { width: 800, height: 600 }, settle: replay => act(replay) });
            const finalStop = after.rect('agent-input-abort');
            expect([finalStop.left, finalStop.top, finalStop.width, finalStop.height, finalStop.receivesPointer])
                .toEqual([initialStop.left, initialStop.top, initialStop.width, initialStop.height, true]);
            // jsdom DOM activation, not a trusted browser pointer: live QA owns that separate gate.
            await act(async () => {
                stop!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
                stop!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
                stop!.click();
            });
            expect(onAbort).toHaveBeenCalledTimes(1);
            // The probe must see a real Stop-state change, even though streamed text leaves it quiet.
            expect(shakerRender).toHaveBeenCalled();
        } finally {
            observer.disconnect();
        }
    });
});

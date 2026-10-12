// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';
import { createSessionMessagesFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { getStorage } from '@/sync/domains/state/storageStore';
import { installWebLockManagerMock, type WebLockManagerMockHandle } from '@/auth/storage/tokenStorage.web.testHelpers';
import { CommandView } from '../CommandView';
import { FindBarPlacement } from '@/components/ui/find/FindBarPlacement';
import { FindBar } from '@/components/ui/find/FindBar';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { ChatTranscriptListItem } from '../chatListTypes';
import { createReadOnlySessionTranscriptSource } from '../source/readOnlySessionTranscriptSource';
import { createTranscriptJumpHostTestHarness, createTranscriptJumpWebMetrics, restoreTranscriptJumpEnvironment } from '../viewport/jump/host/transcriptJumpHostTestHarness';
import { TranscriptFindSurface } from './TranscriptFindSurface';
import { isTranscriptTargetObservedAtAlignment } from '../viewport/window/useTranscriptTargetWindowHostAdapter';
import { createTranscriptFindModel, type TranscriptFindCorpus } from './useTranscriptFind';
import { revealTranscriptFindMatch } from './revealTranscriptFindMatch';

vi.mock('react-native', async () => await import('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
let environment: Awaited<ReturnType<typeof restoreTranscriptJumpEnvironment>> | undefined;
let webLocks: WebLockManagerMockHandle;
beforeEach(async () => {
    webLocks = installWebLockManagerMock();
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1440);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(900);
    await act(async () => { window.dispatchEvent(new Event('resize')); });
    environment = await restoreTranscriptJumpEnvironment();
});
afterEach(async () => { await environment?.dispose(); webLocks.restore(); standardCleanup(); });

function installMessage(message: Message) {
    getStorage().setState(state => ({ sessionMessages: { ...state.sessionMessages,
        s1: createSessionMessagesFixture({ messagesById: { [message.id]: message }, messageIdsOldestFirst: [message.id], isLoaded: true }),
    } }));
}

describe('web Find reveal through the real jump owner', () => {
    it.each(['first-row', 'tall-card'] as const)('lands a complete-coverage %s after the renderer bootstrap changes scrollTop', async (kind) => {
        const tall = kind === 'tall-card';
        const output = `${'diff line\n'.repeat(55)}must not remount the modal\n${'diff line\n'.repeat(20)}`;
        const query = tall ? 'must not remount the modal' : 'remount';
        const message: Message = tall
            ? { kind: 'tool-call', id: 'bootstrap-message', localId: null, seq: 50, createdAt: 1, children: [],
                tool: { id: 'bash', name: 'Bash', state: 'completed', createdAt: 1, startedAt: 1, completedAt: 2,
                    description: null, input: { command: 'git diff --no-color' }, result: { stdout: output, stderr: '' } } }
            : { kind: 'user-text', id: 'bootstrap-message', localId: null, seq: 1, createdAt: 1, text: query };
        installMessage(message);
        const items: ChatTranscriptListItem[] = [{ kind: 'message', id: 'bootstrap-row', messageId: message.id,
            seq: message.seq!, createdAt: 1 }];
        const harness = createTranscriptJumpHostTestHarness({ rows: items, messages: { [message.id]: message } });
        harness.metrics.current = createTranscriptJumpWebMetrics({ rows: [{ id: 'bootstrap-row', top: 0 }],
            scrollTop: 1500, scrollHeight: 3000 });
        const element = harness.metrics.current.element;
        const row = element.querySelector<HTMLElement>('[data-testid="transcript-item-bootstrap-row"]')!;
        const contentY = tall ? 500 : 96;
        const itemHeight = tall ? 1400 : 80;
        const rect = (y: number, height: number) => ({ top: y - element.scrollTop, bottom: y + height - element.scrollTop,
            height, width: 800, left: 0, right: 800, x: 0, y: y - element.scrollTop, toJSON() {} });
        row.getBoundingClientRect = () => rect(contentY, itemHeight);
        const root = createRoot(row);
        await act(async () => root.render(tall ? <CommandView command="git diff --no-color" stdout={output}
            stdoutFindRanges={[{ start: output.indexOf(query), end: output.indexOf(query) + query.length, current: true }]} />
            : <FindHighlightedText text={query} ranges={[{ start: 0, end: query.length, current: true }]} />));
        const mark = row.querySelector<HTMLElement>('[data-testid="find-match-current"]')!;
        mark.getBoundingClientRect = () => rect(contentY + (tall ? 1000 : 0), 20);
        row.remove();
        // The browser renderer can synchronously scroll and mount its requested row. The DOM
        // rectangles then describe the new physical offset, not the driver's pre-bootstrap read.
        harness.listRef.current = { ...harness.renderer,
            scrollToIndex: () => { element.appendChild(row); element.scrollTop = contentY; } };
        const completedLandings: boolean[] = [];
        const hook = await harness.render({ platformOS: 'web',
            executeViewportCommandWithAnimation: command => {
                const applied = harness.base.executeViewportCommand(command);
                if (applied && command.kind === 'jump-to-seq') completedLandings.push(isTranscriptTargetObservedAtAlignment({
                    align: command.align, item: row, metrics: { ...harness.metrics.current!, scrollTop: element.scrollTop },
                }));
                return applied;
            } });
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages: [message], history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } }),
            loadPage: null, jumpToTarget: hook.getCurrent().jumpToTranscriptTarget,
            reveal: (match, context) => revealTranscriptFindMatch(match, { items,
                setToolCallsGroupExpanded() {}, setThinkingExpanded() {}, waitForVisualUpdate: async () => {},
                readClearancePx: () => 96, jumpToTarget: hook.getCurrent().jumpToTranscriptTarget }, context),
        });
        try {
            await act(async () => { model.setQuery(query); await model.settled(); });
            expect(model.status).toMatchObject({ current: 1, total: 1, coverage: 'complete' });
            // The renderer approach may precede the mount; the exact landing that completes the jump is aligned.
            expect(completedLandings.at(-1)).toBe(true);
            expect(mark.getBoundingClientRect().top).toBe(96);
        } finally { model.dispose(); await act(async () => root.unmount()); await hook.unmount(); }
    });

    it.each([false, true])('reveals the current CommandView output line (grouped=%s)', async (grouped) => {
        const output = `${'diff line\n'.repeat(55)}must not remount the modal\n${'diff line\n'.repeat(20)}`;
        const start = output.indexOf('must not remount');
        const message: Message = { kind: 'tool-call', id: 'tool-message', realID: 'persisted-tool', localId: null,
            seq: 50, createdAt: 1, children: [], tool: { id: 'bash', name: 'Bash', state: 'completed',
                createdAt: 1, startedAt: 1, completedAt: 2, description: null,
                input: { command: 'git diff --no-color' }, result: { stdout: output, stderr: '' } } };
        installMessage(message);
        const items: ChatTranscriptListItem[] = grouped ? [
            { kind: 'tool-group-header', id: 'group#header', groupId: 'group', toolMessageIds: [message.id], expanded: true, hiddenCount: 0, createdAt: 1 },
            { kind: 'tool-group-tool', id: 'tool-row', groupId: 'group', toolMessageIds: [message.id], toolMessageId: message.id, expanded: true, seq: 50, createdAt: 1 },
        ] : [{ kind: 'message', id: 'tool-row', messageId: message.id, seq: 50, createdAt: 1 }];
        const harness = createTranscriptJumpHostTestHarness({ rows: items, messages: { [message.id]: message } });
        harness.metrics.current = createTranscriptJumpWebMetrics({ rows: [
            { id: 'group#header', top: -1050, height: 50 }, { id: 'tool-row', top: -1000, height: 1400 },
        ], scrollTop: 1500, scrollHeight: 3000 });
        const element = harness.metrics.current.element;
        const row = element.querySelector<HTMLElement>('[data-testid="transcript-item-tool-row"]')!;
        const rect = (y: number, height: number) => ({ top: y - element.scrollTop, bottom: y + height - element.scrollTop,
            height, width: 800, left: 0, right: 800, x: 0, y: y - element.scrollTop, toJSON() {} });
        row.getBoundingClientRect = () => rect(500, 1400);
        const root = createRoot(row);
        const hook = await harness.render({ platformOS: 'web', resolveWebScrollMetrics: () => ({ ...harness.metrics.current!, scrollTop: element.scrollTop }) });
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages: [message], history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } }),
            loadPage: null, jumpToTarget: hook.getCurrent().jumpToTranscriptTarget,
            reveal: (match, context) => revealTranscriptFindMatch(match, {
                items, setToolCallsGroupExpanded() {}, setThinkingExpanded() {}, waitForVisualUpdate: async () => {},
                readClearancePx: () => 96, jumpToTarget: hook.getCurrent().jumpToTranscriptTarget,
            }, context),
        });
        try {
            await act(async () => { root.render(<CommandView command="git diff --no-color" stdout={output}
                stdoutFindRanges={[{ start, end: start + 'must not remount the modal'.length, current: true }]} />); });
            const mark = row.querySelector<HTMLElement>('[data-testid="find-match-current"]')!;
            expect(mark.textContent).toBe('must not remount the modal');
            mark.getBoundingClientRect = () => rect(1500, 20);
            await act(async () => { model.setQuery('must not remount the modal'); await model.settled(); });
            expect(mark.getBoundingClientRect().top).toBe(96);
            expect(mark.getBoundingClientRect().bottom).toBeLessThan(element.clientHeight);
        } finally { model.dispose(); await act(async () => root.unmount()); await hook.unmount(); }
    });

    it.each(['continue', 'stop', 'close'] as const)('handles a query entered before hydration and later clearance (intent=%s)', async (intent) => {
        const message: Message = { kind: 'user-text', id: 'first-message', localId: null, seq: 1, createdAt: 1, text: 'remount' };
        installMessage(message);
        const items: ChatTranscriptListItem[] = [{ kind: 'message', id: 'first-row', messageId: message.id, seq: 1, createdAt: 1 }];
        const harness = createTranscriptJumpHostTestHarness({ rows: items, messages: { [message.id]: message } });
        harness.metrics.current = createTranscriptJumpWebMetrics({ rows: [{ id: 'first-row', top: 10 }], scrollTop: 0 });
        const element = harness.metrics.current.element;
        let clearance = 0;
        let contentY = 10;
        let scrollTop = 1500;
        // Browser clamping and the recycler's header-resize compensation are external geometry facts.
        Object.defineProperty(element, 'scrollTop', { get: () => scrollTop, set: value => { scrollTop = Math.max(0, value); } });
        const row = element.querySelector('[data-testid="transcript-item-first-row"]')!;
        const rect = () => ({ top: contentY - scrollTop, bottom: contentY + 80 - scrollTop, height: 80,
            width: 800, left: 0, right: 800, x: 0, y: contentY - scrollTop, toJSON() {} });
        row.getBoundingClientRect = rect;
        const root = createRoot(row);
        await act(async () => { root.render(<FindHighlightedText text="remount" ranges={[{ start: 0, end: 7, current: true }]} />); });
        const mark = row.querySelector<HTMLElement>('[data-testid="find-match-current"]')!;
        mark.getBoundingClientRect = rect;
        const hook = await harness.render({ platformOS: 'web', resolveWebScrollMetrics: () => ({ ...harness.metrics.current!, scrollTop: element.scrollTop }) });
        let corpus: TranscriptFindCorpus = { messages: [], history: { isLoaded: false, hasOlder: false, isLoadingOlder: false } };
        const source = createReadOnlySessionTranscriptSource({ sessionId: 's1', serverId: null, messages: [],
            historyState: corpus.history, reducerState: null, metadata: null, agentState: null });
        const model = createTranscriptFindModel({ readCorpus: () => corpus, loadPage: null,
            jumpToTarget: hook.getCurrent().jumpToTranscriptTarget,
            reveal: (match, context) => revealTranscriptFindMatch(match, { items,
                setToolCallsGroupExpanded() {}, setThinkingExpanded() {}, waitForVisualUpdate: async () => {},
                readClearancePx: () => clearance,
                jumpToTarget: hook.getCurrent().jumpToTranscriptTarget }, context),
        });
        const screen = await renderScreen(<PluginSurfaceFocusEligibilityProvider active><TranscriptFindSurface model={model} source={source} sessionId="s1" serverId={null}
            focused viewportRef={React.createRef()} loadedMessages={[]} publishCorpus={next => { corpus = next; }}
            measureMessage={() => null} contentHeight={2000} onClearanceChange={value => { clearance = value; }}><></></TranscriptFindSurface></PluginSurfaceFocusEligibilityProvider>);
        try {
            await act(async () => { model.setQuery('remount'); await model.settled(); });
            expect(model.status).toMatchObject({ current: null, total: 0, coverage: 'loaded' });
            if (intent !== 'continue') await act(async () => model[intent]());
            await act(async () => source.update({ messages: [message],
                historyState: { isLoaded: true, hasOlder: false, isLoadingOlder: false },
                reducerState: null, metadata: null, agentState: null }));
            await model.settled();
            if (intent !== 'continue') {
                expect(scrollTop).toBe(1500);
                expect(model.getSnapshot().open).toBe(intent !== 'close');
                return;
            }
            // Hydration selects the first result with no new query, step or clearance event.
            expect(model.status).toMatchObject({ current: 1, total: 1 });
            expect(mark.getBoundingClientRect().top).toBe(10);
            const placement = screen.tree.root.findByType(FindBarPlacement);
            // The header expands, preserving the old visible row before the Find clearance effect runs.
            contentY = 96; scrollTop = 86;
            await act(async () => { placement.props.onLayout({ nativeEvent: { layout: { x: 14, y: 10, width: 560, height: 74 } } }); });
            await model.settled();
            expect(clearance).toBe(96);
            expect(rect().top).toBe(96);
            expect(mark.getBoundingClientRect().top).toBe(96);
            expect(model.status).toMatchObject({ current: 1, total: 1 });
            expect(model.query).toBe('remount');
        } finally { await act(async () => model.dispose()); await screen.unmount(); await act(async () => root.unmount()); await hook.unmount(); }
    });

    it('re-seats match 8 below the older-history note that appears during that step', async () => {
        const messages: Message[] = Array.from({ length: 8 }, (_, index) => ({
            kind: 'user-text', id: `message-${index + 1}`, localId: null, seq: index + 1,
            createdAt: index + 1, text: 'remount',
        }));
        const items: ChatTranscriptListItem[] = messages.map(message => ({
            kind: 'message', id: `row-${message.id}`, messageId: message.id, seq: message.seq!, createdAt: message.createdAt,
        }));
        const harness = createTranscriptJumpHostTestHarness({ rows: items,
            messages: Object.fromEntries(messages.map(message => [message.id, message])) });
        harness.metrics.current = createTranscriptJumpWebMetrics({
            rows: items.map((item, index) => ({ id: item.id, top: index * 120, height: 80 })),
            scrollTop: 0, scrollHeight: 2000,
        });
        const element = harness.metrics.current.element;
        const targetRow = element.querySelector<HTMLElement>('[data-testid="transcript-item-row-message-8"]')!;
        const rect = () => ({ top: 840 - element.scrollTop, bottom: 920 - element.scrollTop,
            height: 80, width: 800, left: 0, right: 800, x: 0, y: 840 - element.scrollTop, toJSON() {} });
        targetRow.getBoundingClientRect = rect;
        const root = createRoot(targetRow);
        await act(async () => root.render(<FindHighlightedText text="remount" ranges={[{ start: 0, end: 7, current: true }]} />));
        const mark = targetRow.querySelector<HTMLElement>('[data-testid="find-match-current"]')!;
        mark.getBoundingClientRect = rect;
        const hook = await harness.render({ platformOS: 'web',
            resolveWebScrollMetrics: () => ({ ...harness.metrics.current!, scrollTop: element.scrollTop }) });
        let clearance = 0;
        let corpus: TranscriptFindCorpus = { messages, history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } };
        const source = createReadOnlySessionTranscriptSource({ sessionId: 's1', serverId: null, messages,
            historyState: corpus.history, reducerState: null, metadata: null, agentState: null });
        const model = createTranscriptFindModel({ readCorpus: () => corpus, loadPage: null,
            jumpToTarget: hook.getCurrent().jumpToTranscriptTarget,
            reveal: (match, context) => revealTranscriptFindMatch(match, { items,
                setToolCallsGroupExpanded() {}, setThinkingExpanded() {}, waitForVisualUpdate: async () => {},
                readClearancePx: () => clearance, jumpToTarget: hook.getCurrent().jumpToTranscriptTarget }, context),
        });
        const screen = await renderScreen(<PluginSurfaceFocusEligibilityProvider active><TranscriptFindSurface
            model={model} source={source} sessionId="s1" serverId={null} focused viewportRef={React.createRef()}
            loadedMessages={messages} publishCorpus={next => { corpus = next; }} measureMessage={() => null}
            contentHeight={2000} onClearanceChange={value => { clearance = value; }}><></></TranscriptFindSurface></PluginSurfaceFocusEligibilityProvider>);
        try {
            await act(async () => { model.setQuery('remount'); await model.settled(); });
            const placement = screen.tree.root.findByType(FindBarPlacement);
            await act(async () => placement.props.onLayout({ nativeEvent: { layout: { x: 14, y: 10, width: 560, height: 34 } } }));
            for (let index = 1; index < 7; index += 1) {
                await act(async () => { model.step(1); await model.settled(); });
            }
            expect(screen.tree.root.findByType(FindBar).props.note).toBeUndefined();
            await act(async () => {
                model.step(1);
                await model.settled();
                source.update({ messages, historyState: { isLoaded: true, hasOlder: true, isLoadingOlder: false },
                    reducerState: null, metadata: null, agentState: null });
            });
            expect(screen.tree.root.findByType(FindBar).props.note).toMatchObject({ icon: 'history' });
            expect(mark.getBoundingClientRect().top).toBe(56);
            // Native layout reports the new note's height only after the step decides its presence.
            await act(async () => placement.props.onLayout({ nativeEvent: { layout: { x: 14, y: 10, width: 560, height: 74 } } }));
            await model.settled();
            expect(clearance).toBe(96);
            expect(mark.getBoundingClientRect().top).toBe(96);
            expect(model.status).toMatchObject({ current: 8, total: 8, coverage: 'loaded' });
        } finally { await act(async () => model.dispose()); await screen.unmount(); await act(async () => root.unmount()); await hook.unmount(); }
    });
});

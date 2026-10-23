import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import type { Message } from '@happier-dev/session-core/messages';
import type { ChatTranscriptListItem } from '../../../chatListTypes';
import { createSessionMessagesFixture, flushHookEffects, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { TranscriptNavigationEntry } from '../../../navigation/transcriptNavigationTypes';
import { clearTranscriptNavigationVisibilityStore, getTranscriptNavigationVisibilityStore } from '../../visibility/transcriptNavigationVisibilityStore';
import type { restoreTranscriptJumpEnvironment as RestoreTranscriptJumpEnvironment } from './transcriptJumpHostTestHarness';

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { createTranscriptJumpHostTestHarness, restoreTranscriptJumpEnvironment } = await import('./transcriptJumpHostTestHarness');

const SESSION_ID = 'session-landing';
const FIRST = SESSION_ID + ':user-turn:7';
const SECOND = SESSION_ID + ':user-turn:12';
function user(id: string, seq: number): Message {
    return { kind: 'user-text', id, localId: id, createdAt: seq, text: 'prompt ' + seq, seq, transcriptBlockIndex: 0 };
}
function agent(id: string, seq: number, block: number): Message {
    return { kind: 'agent-text', id, localId: id, createdAt: seq * 10 + block, text: 'answer ' + seq + '.' + block,
        seq, transcriptBlockIndex: block, isThinking: false };
}
const MESSAGES: Readonly<Record<string, Message>> = {
    u1: user('u1', 7), a1: agent('a1', 7, 1), a2: agent('a2', 7, 2), a3: agent('a3', 7, 3),
    u2: user('u2', 12), a4: agent('a4', 12, 1), a5: agent('a5', 12, 2),
    a6: agent('a6', 12, 3), a7: agent('a7', 12, 4), a8: agent('a8', 12, 5),
};
const ROWS: readonly ChatTranscriptListItem[] = Object.entries(MESSAGES).map(([messageId, message]) => ({
    kind: 'message', id: 'row-' + messageId, messageId, createdAt: message.createdAt, seq: message.seq ?? null,
}));
function entry(id: string, seq: number): TranscriptNavigationEntry {
    return { id, sessionId: SESSION_ID, seq, routeMessageId: null, transcriptBlockIndex: 0,
        kind: 'user-turn', role: 'user', label: 'prompt ' + seq, promptPreview: 'prompt ' + seq,
        responsePreview: null, createdAtMs: seq, pinned: false, pinnedAtMs: null, loaded: true };
}
const ENTRIES = [entry(FIRST, 7), entry(SECOND, 12)];
let environment: Awaited<ReturnType<typeof RestoreTranscriptJumpEnvironment>>;

describe('transcript jump landing owns the navigation anchor', () => {
    beforeEach(async () => {
        environment = await restoreTranscriptJumpEnvironment();
        getStorage().setState(state => ({ sessionMessages: { ...state.sessionMessages,
            [SESSION_ID]: createSessionMessagesFixture({
                messageIdsOldestFirst: Object.keys(MESSAGES), messagesById: { ...MESSAGES }, isLoaded: true,
            }),
        } }));
    });
    afterEach(async () => {
        clearTranscriptNavigationVisibilityStore(SESSION_ID);
        await environment.dispose();
        standardCleanup();
    });

    it('lands a route message on the exact answer rather than the first row at the same sequence', async () => {
        getStorage().getState().sessionMessages[SESSION_ID]!.reducerState.messageIds.set('source-answer', 'a2');
        getStorage().getState().sessionMessages[SESSION_ID]!.reducerState.messageIds.set('second-answer', 'a3');
        const harness = createTranscriptJumpHostTestHarness({ sessionId: SESSION_ID, rows: ROWS, messages: MESSAGES });
        const landed: unknown[] = [];
        const route = { jumpToSeq: 7, jumpToMessageId: 'server:source-answer', onJumpLanded: (result: unknown) => { landed.push(result); } };
        const hook = await harness.render(route);
        try {
            await flushHookEffects();
            expect(harness.native.indexWrites.at(-1)).toMatchObject({ index: 2, viewPosition: 0.5 });
            expect(landed).toContainEqual({ status: 'scrolled', target: { kind: 'route-message-id', routeMessageId: 'server:source-answer', seqHint: 7 } });
            await hook.rerender(harness.props({ ...route, jumpToMessageId: 'server:second-answer' }));
            await flushHookEffects();
            expect(harness.native.indexWrites.at(-1)).toMatchObject({ index: 3, viewPosition: 0.5 });
        } finally {
            await hook.unmount();
        }
    });

    it('publishes the landed turn until genuine reader movement releases it', async () => {
        const store = getTranscriptNavigationVisibilityStore(SESSION_ID);
        const harness = createTranscriptJumpHostTestHarness({ sessionId: SESSION_ID, rows: ROWS, messages: MESSAGES, isPinned: false });
        harness.native.visibleRange = { startIndex: 3, endIndex: 8 };
        const hook = await harness.render({ transcriptNavigationEntries: ENTRIES });
        const unsubscribe = store.subscribe(() => {});
        try {
            await flushHookEffects();
            expect(store.get().currentAnchorId).toBe(FIRST);
            await act(async () => { await hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 12 }); });
            expect(store.get()).toEqual({ currentAnchorId: SECOND, visibleAnchorIds: [SECOND] });
            expect(harness.native.indexWrites.at(-1)).toMatchObject({ index: 4, animated: true, viewPosition: 0.5 });

            await act(async () => { hook.getCurrent().observeTranscriptNavigationVisibilityForSession({ genuineUserMovement: false }); });
            expect(store.get().currentAnchorId).toBe(SECOND);
            harness.native.visibleRange = { startIndex: 1, endIndex: 6 };
            await act(async () => { hook.getCurrent().observeTranscriptNavigationVisibilityForSession({ genuineUserMovement: true }); });
            expect(store.get().currentAnchorId).toBe(FIRST);
        } finally {
            unsubscribe();
            await hook.unmount();
        }
    });

    it('drops the landed anchor when its entry leaves the anchor set', async () => {
        const store = getTranscriptNavigationVisibilityStore(SESSION_ID);
        const harness = createTranscriptJumpHostTestHarness({ sessionId: SESSION_ID, rows: ROWS, messages: MESSAGES, isPinned: false });
        harness.native.visibleRange = { startIndex: 3, endIndex: 8 };
        const hook = await harness.render({ transcriptNavigationEntries: ENTRIES });
        const unsubscribe = store.subscribe(() => {});
        try {
            await act(async () => { await hook.getCurrent().jumpToTranscriptTarget({ kind: 'seq', seq: 12 }); });
            expect(store.get().currentAnchorId).toBe(SECOND);
            await hook.rerender(harness.props({ transcriptNavigationEntries: [ENTRIES[0]!] }));
            await flushHookEffects();
            expect(store.get().currentAnchorId).toBe(FIRST);
        } finally {
            unsubscribe();
            await hook.unmount();
        }
    });
});

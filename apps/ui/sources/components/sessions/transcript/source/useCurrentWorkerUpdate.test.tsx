import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';
import { createSessionFixture, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { serveSessionActionHome } from '@/dev/testkit/harness/sessionActionHome';
import { storage } from '@/sync/domains/state/storageStore';
import { AppSessionTranscriptSourceProvider } from './appSessionTranscriptSource';
import { useCurrentWorkerUpdate } from './useCurrentWorkerUpdate';

afterEach(standardCleanup);

it('keeps worker-notice currentness fresh without rereading history for text-only chunks', async () => {
    const home = await serveSessionActionHome();
    const previous = storage.getState();
    const session = createSessionFixture({ id: 'worker-notice-stream', serverId: home.serverId });
    const update = { v: 1, workerKind: 'session', workerId: 'worker', ownerState: 'settled',
        wake: 'finished', headline: 'Finished', canInspect: false } as const;
    const notice = (id: string, seq: number): NormalizedMessage => ({ id, seq, localId: null, createdAt: seq,
        role: 'event', isSidechain: false, content: { type: 'worker-update', update } });
    const stream = (tick: number): NormalizedMessage => ({ id: 'stream', seq: 102, localId: 'stream', createdAt: 102,
        role: 'agent', isSidechain: false, content: [{ type: 'text', text: `tick ${tick}`, uuid: 'stream', parentUUID: null }],
        meta: { happierStreamSegmentV1: { v: 1, segmentKind: 'assistant', segmentLocalId: 'stream',
            segmentState: 'streaming', updatedAtMs: tick } } });
    try {
        storage.getState().applySessions([session]);
        storage.getState().applyMessages(session.id, [notice('notice', 1), ...Array.from({ length: 100 }, (_, index): NormalizedMessage => ({
            id: `history-${index}`, seq: index + 2, localId: null, createdAt: index + 2,
            role: 'user', isSidechain: false, content: { type: 'text', text: 'Earlier prompt' },
        })), stream(1)]);
        storage.getState().applyMessagesLoaded(session.id);
        const transcript = storage.getState().sessionMessages[session.id]!;
        const noticeId = transcript.messageIdsOldestFirst[0]!;
        let historyReads = 0;
        // The first prompt is also the live Session-list title: its bounded
        // publication reads are legitimate. Observe the other 99 retained rows
        // to distinguish a worker-notice history scan from that rendered field.
        for (const id of transcript.messageIdsOldestFirst.slice(2, 101)) {
            const message = transcript.messagesById[id]!;
            const kind = message.kind;
            Object.defineProperty(message, 'kind', { enumerable: true, configurable: true,
                get: () => { historyReads++; return kind; } });
        }
        const hook = await renderHook(() => useCurrentWorkerUpdate(update, noticeId, home.serverId), {
            wrapper: props => <AppSessionTranscriptSourceProvider sessionId={session.id} serverId={home.serverId}>{props.children}</AppSessionTranscriptSourceProvider>,
        });
        try {
            await flushHookEffects();
            expect(hook.getCurrent()).toBe(true);
            historyReads = 0;
            for (let tick = 2; tick <= 4; tick++) {
                await act(async () => { storage.getState().applyMessages(session.id, [stream(tick)]); });
                expect(hook.getCurrent()).toBe(true);
            }
            expect(historyReads).toBe(0);
            await act(async () => { storage.setState(state => ({ sessions: { ...state.sessions,
                [session.id]: { ...state.sessions[session.id]!, serverId: 'another-home' } } })); });
            expect(hook.getCurrent()).toBe(false);
            await act(async () => { storage.setState(state => ({ sessions: { ...state.sessions, [session.id]: session } })); });
            expect(hook.getCurrent()).toBe(true);
            await act(async () => { storage.getState().applyMessages(session.id, [notice('new-notice', 103)]); });
            expect(hook.getCurrent()).toBe(false);
        } finally { await hook.unmount(); }
    } finally { storage.setState(previous); await home.dispose(); }
});

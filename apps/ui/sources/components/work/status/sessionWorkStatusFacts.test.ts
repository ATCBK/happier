import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionFromListRenderable } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';

import { resolveWorkStatusTone } from './resolveWorkStatusTone';
import { readSessionWorkStalled, readSessionWorkStatusFacts, withOutstandingReports } from './sessionWorkStatusFacts';

const NOW = 1_000_000;

describe('readSessionWorkStatusFacts', () => {
    it('keeps an HTTP-loaded inactive row offline before and after unchanged details hydrate', () => {
        const row = createSessionListRenderableSessionFixture({
            encryptionMode: 'e2ee', encryptedContentAvailability: undefined, metadata: null,
            presence: undefined, active: false, activeAt: NOW - 3_600_000,
            hasPendingPermissionRequests: undefined, hasPendingUserActionRequests: undefined,
        });
        const cold = buildSessionFromListRenderable(row, { serverId: 'home-a' });
        const status = resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(cold, NOW) });
        expect(status).toEqual({ bucket: 'offline', tone: 'neutral', word: 'sessionWork.states.stopped' });
        // The content remains unavailable during hydration; a public runtime word grants no read.
        expect(readSessionWorkStatusFacts(cold, NOW).awareness.encryption).toBe('unknown');
        const hydrated = createSessionFixture({ ...cold, encryptedContentAvailability: 'ready',
            metadata: createSessionFixture().metadata, presence: 0 });
        expect(resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(hydrated, NOW) })).toEqual(status);
    });

    it('names an unknown runtime state with a quiet localized word', () => {
        const row = createSessionListRenderableSessionFixture({
            encryptionMode: 'e2ee', encryptedContentAvailability: undefined, metadata: null,
            active: true, presence: undefined,
        });
        const status = resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(row, NOW) });
        expect(status).toEqual({ bucket: 'idle', tone: 'neutral', word: 'status.unknownState' });
    });

    it('says a detached Session has stopped, and offline only when its runner was lost mid-turn', () => {
        // A hydrated row the Home marked inactive, with no device-observed presence.
        const detached = createSessionListRenderableSessionFixture({ active: false, presence: undefined, activeAt: NOW - 3_600_000 });
        const facts = readSessionWorkStatusFacts(detached, NOW);
        expect(facts.word).toBe('sessionWork.states.stopped');
        expect(resolveWorkStatusTone({ kind: 'session', facts }).bucket).toBe('offline');

        const lost = createSessionListRenderableSessionFixture({ active: false, activeAt: NOW, presence: 0,
            latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: NOW });
        expect(readSessionWorkStalled(lost, NOW)).toBe(true);
        expect(readSessionWorkStatusFacts(lost, NOW).word).toBe('status.offline');
    });

    it('reads a list row the way the Session owner does: a pending permission needs you, a turn in flight is not settled', () => {
        const waiting = createSessionListRenderableSessionFixture({
            active: true, activeAt: NOW, hasPendingPermissionRequests: true, pendingRequestObservedAt: NOW,
        });
        expect(resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(waiting, NOW) }).bucket).toBe('needs_you');

        const working = createSessionListRenderableSessionFixture({
            active: true, activeAt: NOW, thinking: true, thinkingAt: NOW, latestTurnStatus: 'in_progress',
        });
        const workingFacts = readSessionWorkStatusFacts(working, NOW);
        expect(workingFacts.settled).toBe(false);
        expect(resolveWorkStatusTone({ kind: 'session', facts: workingFacts }).bucket).toBe('working');

    });

    it('reads Finished only from a settlement the Session states, Idle otherwise, and Offline before either', () => {
        const bucketOf = (overrides: Parameters<typeof createSessionListRenderableSessionFixture>[0]) =>
            resolveWorkStatusTone({
                kind: 'session',
                facts: readSessionWorkStatusFacts(createSessionListRenderableSessionFixture(overrides), NOW),
            }).bucket;

        // Quiet is not settled: no turn in flight says nothing about the work being done.
        expect(bucketOf({ active: true, activeAt: NOW })).toBe('idle');
        // The owner's own settlement: its latest turn completed and it says Ready.
        expect(bucketOf({ active: true, activeAt: NOW, latestTurnStatus: 'completed' })).toBe('finished');
        // Presence wins over a settlement the runtime can no longer stand behind.
        expect(bucketOf({ presence: 1, active: false, activeAt: 1, latestTurnStatus: 'completed' })).toBe('offline');
        expect(bucketOf({ presence: 1, active: false, activeAt: 1 })).toBe('offline');
    });

    it('never calls a lead settled while its reports are still outstanding (R-10), whoever counts them', () => {
        const lead = createSessionListRenderableSessionFixture({
            active: true, activeAt: NOW, latestTurnStatus: 'completed', managedSessions: { total: 2, working: 1, needsYou: 0, stalled: 0 },
        });
        // The server's count of the lead's reports, read from the Session itself.
        const fromAwareness = readSessionWorkStatusFacts(lead, NOW);
        expect(fromAwareness.settled).toBe(false);
        expect(resolveWorkStatusTone({ kind: 'session', facts: fromAwareness }).bucket).not.toBe('finished');

        // The Work projection, which counts the subtree it holds, supplies its own count.
        const ready = createSessionListRenderableSessionFixture({ active: true, activeAt: NOW, latestTurnStatus: 'completed' });
        const settled = readSessionWorkStatusFacts(ready, NOW);
        expect(settled.settled).toBe(true);
        expect(withOutstandingReports(settled, 1).settled).toBe(false);
        expect(withOutstandingReports(settled, 0)).toBe(settled);

        const doneReports = createSessionListRenderableSessionFixture({
            active: true, activeAt: NOW, latestTurnStatus: 'completed', managedSessions: { total: 2, working: 0, needsYou: 0, stalled: 0 },
        });
        expect(readSessionWorkStatusFacts(doneReports, NOW).settled).toBe(true);
    });

    it('calls a Session stalled only when it is offline with a turn in flight, never because of its reports (O7)', () => {
        // An offline lead whose reports still work, with no turn of its own in flight: not settled (R-10),
        // and not stalled either.
        const offlineLead = createSessionListRenderableSessionFixture({
            presence: 1, active: false, activeAt: 1, managedSessions: { total: 2, working: 1, needsYou: 0, stalled: 0 },
        });
        expect(readSessionWorkStatusFacts(offlineLead, NOW).settled).toBe(false);
        expect(readSessionWorkStalled(offlineLead, NOW)).toBe(false);

        const offlineMidTurn = createSessionListRenderableSessionFixture({
            presence: 1, active: false, activeAt: 1, latestTurnStatus: 'in_progress',
        });
        expect(readSessionWorkStalled(offlineMidTurn, NOW)).toBe(true);

        const onlineMidTurn = createSessionListRenderableSessionFixture({
            active: true, activeAt: NOW, thinking: true, thinkingAt: NOW, latestTurnStatus: 'in_progress',
        });
        expect(readSessionWorkStalled(onlineMidTurn, NOW)).toBe(false);
    });
});

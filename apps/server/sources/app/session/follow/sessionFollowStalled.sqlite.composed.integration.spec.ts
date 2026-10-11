import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccountEncryptionCurrentnessResponse, SessionFollowPendingObservationV1,
    SessionFollowUpdateEnvelopeV1, V2SessionRecord, WorkerUpdateV1 } from '@happier-dev/protocol';
import { SESSION_FOLLOW_WAKE_EVENT_MESSAGE } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { expireSessionPublisherCandidates } from '@/app/presence/sessionPublisherPresence';
import { setSessionReportsTo } from '@/app/session/relations/sessionReportsToService';
import { parseStoredSessionLatestTurnStatus } from '@/app/session/listing/rows';
import { readCurrentSourceSessionFollowFrontier, writeSessionFollowFrontierColumns } from '@/app/session/relations/sessionEdgeFrontier';
import { acknowledgeSessionFollowFrontierInTx, observePendingSessionFollowForDestinationInTx } from './sessionFollowEdgeService';

describe('presence → Follow stalled WorkerUpdate acceptance', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-follow-stalled-' }); }, 180_000);
    afterAll(async () => { await harness?.close(); });
    afterEach(async () => {
        await db.sessionMessage.deleteMany();
        await db.session.deleteMany();
        await db.account.deleteMany();
    });

    async function fixture(status: 'in_progress' | 'completed' = 'in_progress') {
        // Nearest-project Vitest resolution loads real CLI owners without
        // pulling CLI aliases into the server's TypeScript compilation.
        const { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } = await vi.importActual<{
            createAccountEncryptionCurrentnessFixture: () => AccountEncryptionCurrentnessResponse;
            createSessionRecordFixture: (input: Partial<V2SessionRecord> & { id: string }) => V2SessionRecord;
        }>('../../../../../cli/src/testkit/backends/sessionFixtures');
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const source = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/worker', host: 'host' }), active: true,
            lastActiveAt: new Date(0), latestTurnId: 'worker-turn', latestTurnStatus: status,
        } });
        const destination = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}', publisherGeneration: 1n,
        } });
        const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
        const principal = { kind: 'destination_runtime' as const, destinationRuntimeAccountId: account.id, authentication };
        expect(await setSessionReportsTo({ accountId: account.id, sessionId: source.id,
            leadSessionId: destination.id, expectedLeadSessionId: null, authentication })).toMatchObject({ ok: true });
        await db.sessionReportsTo.update({ where: { sessionId: source.id },
            data: writeSessionFollowFrontierColumns(readCurrentSourceSessionFollowFrontier(source)) });
        const observe = () => inTx((tx) => observePendingSessionFollowForDestinationInTx(tx, {
            principal, destinationSessionId: destination.id, includeReportsTo: true,
        }));
        const acknowledgements: Array<Promise<unknown>> = [];
        // Socket and HTTP adapters are boundaries; presence, observation, hydration,
        // admission and ACK all execute their real owners against SQLite.
        const session = {
            sessionId: destination.id,
            runSessionFollowSourceRequest: <T>({ request }: { request: () => T }) => request(),
            observePendingSessionFollow: async () => ({ ok: true, publisherGeneration: '1', ...await observe() }),
            acknowledgeSessionFollow: (request: Omit<Parameters<typeof acknowledgeSessionFollowFrontierInTx>[1],
                'principal' | 'destinationSessionId' | 'expectedPublisherGeneration'>) => {
                const ack = inTx((tx) => acknowledgeSessionFollowFrontierInTx(tx, {
                    ...request, principal, destinationSessionId: destination.id, expectedPublisherGeneration: 1n,
                }));
                acknowledgements.push(ack);
                return ack;
            },
        };
        const hydrateOptions = { session,
            credentials: { token: 'test', encryption: null }, deps: {
                resolveSourceTransport: async () => {
                    const row = await db.session.findUniqueOrThrow({ where: { id: source.id } });
                    return { ok: true, sessionId: row.id, mode: 'plain', ctx: null,
                        accountEncryptionCurrentness: createAccountEncryptionCurrentnessFixture(),
                        rawSession: createSessionRecordFixture({ id: row.id, seq: row.seq, metadata: row.metadata,
                            encryptionMode: 'plain', active: row.active,
                            latestTurnStatus: parseStoredSessionLatestTurnStatus(row.latestTurnStatus),
                            createdAt: row.createdAt.getTime(), updatedAt: row.updatedAt.getTime(),
                            activeAt: row.lastActiveAt.getTime(), archivedAt: null,
                            latestTurnStatusObservedAt: row.latestTurnStatusObservedAt === null ? null : Number(row.latestTurnStatusObservedAt),
                            pendingReviewRuns: 0 }),
                    };
                },
                fetchTranscriptPage: async () => ({
                    messages: (await db.sessionMessage.findMany({ where: { sessionId: source.id }, orderBy: { seq: 'desc' } }))
                        .map((row) => ({ seq: row.seq, createdAt: row.createdAt.getTime(), content: row.content })),
                    hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
                }),
            },
        };
        type HydratedUpdate = SessionFollowUpdateEnvelopeV1 & { workerUpdate?: WorkerUpdateV1 };
        const { createSessionFollowSourceHydrator } = await vi.importActual<{
            createSessionFollowSourceHydrator: (options: typeof hydrateOptions) => (input: {
                observation: SessionFollowPendingObservationV1; signal: AbortSignal;
            }) => Promise<HydratedUpdate | null>;
        }>('../../../../../cli/src/agent/runtime/session/follow/sessionFollowSourceHydrator');
        const hydrateObservation = createSessionFollowSourceHydrator(hydrateOptions);
        type PreparedContext = {
            workerUpdates?: readonly WorkerUpdateV1[];
            updates: readonly SessionFollowUpdateEnvelopeV1[];
            wakeEventLocalId?: string;
            recheckAdmission: (signal: AbortSignal) => Promise<boolean>;
            acknowledgeAccepted: (input: { kind: 'context_only_wake'; eventLocalId: string }) => void;
        };
        const { createSessionFollowContextReconciler } = await vi.importActual<{
            createSessionFollowContextReconciler: (options: {
                session: typeof session; hydrateObservation: typeof hydrateObservation; maxFollowContextUtf8Bytes: number;
            }) => (input: { signal: AbortSignal; deliveryIntent: 'wake' }) => Promise<PreparedContext | null>;
        }>('../../../../../cli/src/agent/runtime/session/follow/sessionFollowContextReconciler');
        const makeReconciler = () => createSessionFollowContextReconciler({
            session, hydrateObservation, maxFollowContextUtf8Bytes: 8192,
        });
        const wake = (reconcile = makeReconciler()) => reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' });
        const offline = () => expireSessionPublisherCandidates({ candidates: [{ sessionId: source.id, observedFence: source.lastActiveAt }] });
        const advanceTranscript = async () => {
            await db.sessionMessage.create({ data: { sessionId: source.id, seq: 1, messageRole: 'agent',
                content: { t: 'plain', v: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Still working' } } } },
                transcriptObservationProvenance: { kind: 'non_dependent', source: 'external' } } });
            await db.session.update({ where: { id: source.id }, data: { seq: 1 } });
        };
        return { source, destination, observe, wake, offline, acknowledgements, advanceTranscript };
    }

    it('delivers exactly one stalled update after offline mid-turn, ACKs it, and recovers without duplicate or completion', async () => {
        const f = await fixture();
        expect(await f.wake()).toBeNull();
        const leadChangeBefore = await db.accountChange.findFirstOrThrow({
            where: { kind: 'session', entityId: f.destination.id }, select: { cursor: true },
        });
        expect(await f.offline()).toMatchObject([{ status: 'expired' }]);
        const leadChangeAfter = await db.accountChange.findFirstOrThrow({
            where: { kind: 'session', entityId: f.destination.id }, select: { cursor: true },
        });
        expect(leadChangeAfter.cursor).toBeGreaterThan(leadChangeBefore.cursor);
        expect((await f.observe()).observations).toEqual([expect.objectContaining({
            observed: { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0,
                turn: { id: 'worker-turn', status: 'stalled' } },
        })]);
        const prepared = await f.wake();
        expect(prepared?.workerUpdates).toEqual([expect.objectContaining({ ownerState: 'stalled', wake: 'stalled', workerId: f.source.id })]);
        expect(prepared?.updates).toEqual([]);
        expect(await prepared?.recheckAdmission(new AbortController().signal)).toBe(true);
        expect(f.acknowledgements).toEqual([]);
        await db.sessionMessage.create({ data: { sessionId: f.destination.id, seq: 1,
            localId: prepared!.wakeEventLocalId!, messageRole: 'event',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'event',
                data: { type: 'message', message: SESSION_FOLLOW_WAKE_EVENT_MESSAGE } } } },
            transcriptObservationProvenance: { kind: 'non_dependent', source: 'external' } } });
        prepared!.acknowledgeAccepted({ kind: 'context_only_wake', eventLocalId: prepared!.wakeEventLocalId! });
        expect(await Promise.all(f.acknowledgements)).toEqual([expect.objectContaining({ ok: true })]);
        expect((await f.observe()).observations).toEqual([]);
        expect(await f.wake()).toBeNull(); // A fresh reconciler represents lead restart/reconnect.
        await db.session.update({ where: { id: f.source.id }, data: { active: true } });
        expect(await f.wake()).toBeNull();
        expect(await f.offline()).toMatchObject([{ status: 'expired' }]);
        expect(await f.wake()).toBeNull(); // Same turn remains acknowledged after recovery.
        await f.advanceTranscript();
        expect(await f.wake()).toBeNull(); // Unrelated transcript progress cannot re-report the stalled turn.
        await db.session.update({ where: { id: f.source.id }, data: { latestTurnId: 'next-worker-turn' } });
        expect((await f.wake())?.workerUpdates).toEqual([expect.objectContaining({ ownerState: 'stalled' })]);
    });

    it.each(['presence recovers', 'turn completes'] as const)('withdraws a prepared stalled wake if %s before dispatch', async (recovery) => {
        const f = await fixture();
        await f.offline();
        const prepared = await f.wake();
        expect(prepared?.workerUpdates?.[0]?.ownerState).toBe('stalled');
        await f.advanceTranscript(); // Recovery still has a pending ordinary frontier.
        await db.session.update({ where: { id: f.source.id }, data: recovery === 'presence recovers'
            ? { active: true } : { latestTurnStatus: 'completed' } });
        expect(await prepared?.recheckAdmission(new AbortController().signal)).toBe(false);
        expect(f.acknowledgements).toEqual([]);
    });

    it('does not deliver stalled for an inactive completed turn whose frontier was already accepted', async () => {
        const f = await fixture('completed');
        expect(await f.offline()).toMatchObject([{ status: 'expired' }]);
        expect((await f.observe()).observations).toEqual([]);
        expect(await f.wake()).toBeNull();
    });
});

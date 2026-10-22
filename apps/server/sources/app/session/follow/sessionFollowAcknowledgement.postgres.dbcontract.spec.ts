import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deriveSessionFollowWakeEventLocalIdV1, SESSION_FOLLOW_WAKE_EVENT_MESSAGE } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { MACHINE_PLAIN_DATA_KEY_MARKER, TranscriptRawAgentEventV1Schema } from '@happier-dev/protocol';
import { decodeBase64 } from 'privacy-kit';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';

import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { db, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { acknowledgeSessionFollowFrontierInTx, observePendingSessionFollowForDestinationInTx, setSessionFollowSource } from './sessionFollowEdgeService';
import { setSessionManager } from './sessionManagerService';
import { assertConcurrentFailedTurnRouteAcknowledgements } from './sessionFollowAcknowledgement.testkit';
import { acceptAccountFollowPersonalProgress } from './accountFollowPersonalProgress';
import { getAccountFollowRule, setAccountFollowRule } from './accountFollowRuleService';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Follow accepted-prefix ACK on PostgreSQL', () => {
    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error('Missing DATABASE_URL for disposable PostgreSQL contract');
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it('admits personal progress before a Session deletion lock can wait on its Account publication', async () => {
        const account = await db.account.create({ data: { id: `z-${randomUUID()}`, publicKey: randomUUID(), encryptionMode: 'plain' } });
        const viewer = await db.account.create({ data: { id: `a-${randomUUID()}`, publicKey: randomUUID(), encryptionMode: 'plain' } });
        const previousHome = process.env.HAPPIER_SERVER_IDENTITY_ID;
        const homeId = `srv_${'f'.repeat(32)}`;
        process.env.HAPPIER_SERVER_IDENTITY_ID = homeId;
        try {
            const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
            const installationId = randomUUID();
            const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: encodePlainMachineStoredContent({}), installationId,
                dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)) } });
            const source = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
                agentStateVersion: 1, pendingUserActionRequestCount: 1 } });
            await db.sessionShare.create({ data: { sessionId: source.id, sharedByUserId: account.id, sharedWithUserId: viewer.id, accessLevel: 'view' } });
            await db.accessKey.create({ data: { accountId: account.id, sessionId: source.id, machineId: machine.id,
                data: MACHINE_PLAIN_DATA_KEY_MARKER } });
            await db.session.update({ where: { id: source.id }, data: { runtimeMachineTarget: {
                homeId, accountId: account.id, sessionId: source.id, machineId: machine.id, installationId,
            } } });
            await db.accountSessionFollow.create({ data: { accountId: account.id, sessionId: source.id,
                following: true, followPolicy: JSON.stringify({ preset: "important" }) } });
            const scope = { accountId: account.id, authentication, ruleId: randomUUID() };
            const created = await setAccountFollowRule({ ...scope, mutation: { receiver: { kind: 'account' }, expectedVersion: -1,
                content: { t: 'plain', v: { v: 1, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'important' } } } } });
            if (!created.ok) throw new Error(created.error);
            const requestId = randomUUID();
            const occurrence = { sourceSessionId: source.id, expectedSourcePublisherGeneration: source.publisherGeneration.toString(),
                machineId: machine.id, installationId, rules: [{ ruleId: scope.ruleId, ruleVersion: created.value.rule.version, requestIds: [requestId] }],
                sourceRequests: { agentStateVersion: 1, requests: [{ requestId, createdAt: Date.now() }] } };
            // Establish the actual public admission and reserved-row writer,
            // rather than accepting a fixture that exits before publication.
            expect(await acceptAccountFollowPersonalProgress({ accountId: account.id, authentication, occurrence }))
                .toEqual({ ok: true, value: { accepted: true, alreadyRepresented: false } });
            await db.session.update({ where: { id: source.id }, data: { agentStateVersion: 2 } });
            // Exercise a new FK insertion, not an existing coalesced row whose
            // unchanged Session reference need not be revalidated by PostgreSQL.
            await db.accountChange.deleteMany({ where: { accountId: account.id, kind: 'session', entityId: source.id } });

            let release!: () => void;
            let acquired!: (pid: number) => void;
            const gate = new Promise<void>(resolve => { release = resolve; });
            const ready = new Promise<number>(resolve => { acquired = resolve; });
            // Physical deletion takes this same strong Session lock before its
            // Account tail. NOWAIT makes the inverted edge observable without
            // relying on a deadlock victim or changing production retry policy.
            const holder = db.$transaction(async tx => {
                await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${source.id} FOR UPDATE`;
                const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                acquired(backend!.pid);
                await gate;
                await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${account.id} FOR NO KEY UPDATE NOWAIT`;
            }, { timeout: 30_000 }).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
            let progress: ReturnType<typeof acceptAccountFollowPersonalProgress> | undefined;
            try {
                const pid = await ready;
                progress = acceptAccountFollowPersonalProgress({ accountId: account.id, authentication,
                    occurrence: { ...occurrence, sourceRequests: { ...occurrence.sourceRequests, agentStateVersion: 2 } } });
                void progress.catch(() => undefined);
                await vi.waitFor(async () => {
                    const [waiting] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                        SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))) AS blocked`;
                    expect(waiting?.blocked).toBe(true);
                });
                release();
                expect(await holder).toEqual({ ok: true });
                expect(await progress).toEqual({ ok: true, value: { accepted: true, alreadyRepresented: false } });
                expect(await getAccountFollowRule(scope)).toMatchObject({ ok: true, value: { rule: {
                    sources: [{ sourceSessionId: source.id, delivered: { agentStateVersion: 2 } }],
                } } });
                expect(await db.accountChange.findFirst({ where: { accountId: account.id, kind: 'session', entityId: source.id } }))
                    .toMatchObject({ sessionId: source.id });
            } finally {
                release();
                await holder;
                await progress?.catch(() => undefined);
            }
        } finally {
            if (previousHome === undefined) delete process.env.HAPPIER_SERVER_IDENTITY_ID;
            else process.env.HAPPIER_SERVER_IDENTITY_ID = previousHome;
            // The disposable database harness owns teardown of this connected
            // Session/Machine fixture, as it does the socket ACK fixtures below.
        }
    });

    it('observes pending Follow work while the same socket heartbeat waits on Account publication', async () => {
        const previousSessions = process.env.HAPPIER_FEATURE_SESSIONS__ENABLED;
        const previousFollowing = process.env.HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED;
        process.env.HAPPIER_FEATURE_SESSIONS__ENABLED = '1';
        process.env.HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED = '1';
        try {
            await assertConcurrentFailedTurnRouteAcknowledgements({
                duringObservation: async ({ accountId, presence, socket, observe }) => {
                    let release!: () => void;
                    let locked!: (pid: number) => void;
                    const gate = new Promise<void>(resolve => { release = resolve; });
                    const acquired = new Promise<number>(resolve => { locked = resolve; });
                    const holder = db.$transaction(async tx => {
                        await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${accountId} FOR NO KEY UPDATE`;
                        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                        locked(backend!.pid);
                        await gate;
                    }, { timeout: 30_000 });
                    let heartbeat: ReturnType<typeof presence.touchPublisher> | undefined;
                    let observation: Awaited<ReturnType<typeof observe>> | undefined;
                    let pendingObservation: ReturnType<typeof observe> | undefined;
                    try {
                        const pid = await acquired;
                        heartbeat = presence.touchPublisher({ socket });
                        await vi.waitFor(async () => {
                            const [waiting] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                                SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                                    WHERE ${pid}::int = ANY(pg_blocking_pids(pid))) AS blocked`;
                            expect(waiting?.blocked).toBe(true);
                        });
                        pendingObservation = observe();
                        void pendingObservation.then(value => { observation = value; });
                        await vi.waitFor(() => expect(observation).toBeDefined(), { timeout: 1_000 });
                        return observation!;
                    } finally {
                        release();
                        await holder;
                        await heartbeat;
                        await pendingObservation?.catch(() => undefined);
                    }
                },
            });
        } finally {
            if (previousSessions === undefined) delete process.env.HAPPIER_FEATURE_SESSIONS__ENABLED;
            else process.env.HAPPIER_FEATURE_SESSIONS__ENABLED = previousSessions;
            if (previousFollowing === undefined) delete process.env.HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED;
            else process.env.HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED = previousFollowing;
        }
    });

    it('commits both concurrent socket routes for one accepted input and a failed source turn', async () => {
        const previousSessions = process.env.HAPPIER_FEATURE_SESSIONS__ENABLED;
        const previousFollowing = process.env.HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED;
        process.env.HAPPIER_FEATURE_SESSIONS__ENABLED = '1';
        process.env.HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED = '1';
        try { await assertConcurrentFailedTurnRouteAcknowledgements({
            duringAcknowledgements: async ({ accountId, presence, socket, acknowledge }) => {
                let release!: () => void;
                let locked!: (pid: number) => void;
                const gate = new Promise<void>(resolve => { release = resolve; });
                const acquired = new Promise<number>(resolve => { locked = resolve; });
                const holder = db.$transaction(async tx => {
                    await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${accountId} FOR NO KEY UPDATE`;
                    const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                    locked(backend!.pid);
                    await gate;
                }, { timeout: 30_000 });
                let heartbeat: ReturnType<typeof presence.touchPublisher> | undefined;
                try {
                    const pid = await acquired;
                    heartbeat = presence.touchPublisher({ socket });
                    // Prove the same socket's heartbeat is actually waiting for
                    // this Account holder, rather than inferring from elapsed time.
                    await vi.waitFor(async () => {
                        const [waiting] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                            SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                                WHERE ${pid}::int = ANY(pg_blocking_pids(pid))) AS blocked`;
                        expect(waiting?.blocked).toBe(true);
                    });
                    await acknowledge(); // Must commit both routes before releasing Account.
                } finally {
                    release();
                    await holder;
                    await heartbeat;
                }
            },
        }); }
        finally {
            if (previousSessions === undefined) delete process.env.HAPPIER_FEATURE_SESSIONS__ENABLED;
            else process.env.HAPPIER_FEATURE_SESSIONS__ENABLED = previousSessions;
            if (previousFollowing === undefined) delete process.env.HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED;
            else process.env.HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED = previousFollowing;
        }
    });

    it('settles a covered ordinary prefix after manager ACK, preserving attachment, publisher and live-turn fences', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        try {
            const source = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}',
                encryptionMode: 'plain', seq: 0, latestTurnId: 'previous', latestTurnStatus: 'completed' } });
            const destination = await db.session.create({ data: { accountId: account.id, tag: randomUUID(),
                metadata: '{}', encryptionMode: 'plain', publisherGeneration: 1n } });
            const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
            const principal = { kind: 'destination_runtime' as const, destinationRuntimeAccountId: account.id, authentication };
            expect(await setSessionFollowSource({ policy: { preset: 'quiet' as const }, accountId: account.id, sourceSessionId: source.id,
                destinationSessionId: destination.id, authentication })).toMatchObject({ ok: true });
            expect(await setSessionManager({ accountId: account.id, sessionId: source.id, managerSessionId: destination.id,
                expectedManagerSessionId: null, authentication })).toMatchObject({ ok: true });
            await db.session.update({ where: { id: source.id }, data: { seq: 3, latestTurnId: 'current', latestTurnStatus: 'failed' } });
            const result = await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
                principal, destinationSessionId: destination.id, includeManager: true,
            }));
            const observations = result.observations.filter(row => 'relation' in row);
            const manager = observations.find(row => row.relation === 'manager');
            const follower = observations.find(row => row.relation === 'follower');
            if (!manager || !follower) throw new Error('Expected independently admitted manager and ordinary routes');
            const represented = observations.map(row => ({ policy: row.policy, sourceSessionId: row.sourceSessionId, relation: row.relation,
                ...(row.relation === 'manager' ? { attachedAt: row.attachedAt } : {}),
                expected: row.delivered, consumed: { ...row.delivered, transcriptSeq: 1 } }));
            const eventLocalId = deriveSessionFollowWakeEventLocalIdV1({ destinationSessionId: destination.id,
                publisherGeneration: destination.publisherGeneration.toString(), observations: represented });
            // The durable host-event boundary is real; no admitted-input witness is substituted.
            await db.sessionMessage.create({ data: { sessionId: destination.id, seq: 1, localId: eventLocalId,
                messageRole: 'event', content: { t: 'plain', v: { role: 'agent', content: { type: 'event',
                    data: TranscriptRawAgentEventV1Schema.parse({ type: 'message', message: SESSION_FOLLOW_WAKE_EVENT_MESSAGE }) } } },
                transcriptObservationProvenance: { kind: 'non_dependent', source: 'external' } } });
            const base = { principal, sourceSessionId: source.id, destinationSessionId: destination.id,
                expectedPublisherGeneration: destination.publisherGeneration,
                acceptance: { kind: 'context_only_wake' as const, eventLocalId, observations: represented } };
            const managerConsumed = { ...manager.delivered, transcriptSeq: 1 };
            expect(await inTx(tx => acknowledgeSessionFollowFrontierInTx(tx, { ...base, relation: 'manager',
                policy: manager.policy,
                attachedAt: manager.attachedAt, expected: manager.delivered, observed: manager.observed, consumed: managerConsumed })))
                .toEqual({ ok: true, delivered: managerConsumed });
            const followerConsumed = { ...follower.delivered, transcriptSeq: 1 };
            const followerAck = { ...base, policy: follower.policy, relation: 'follower' as const, expected: follower.delivered,
                observed: follower.observed, consumed: followerConsumed };
            expect(await inTx(tx => acknowledgeSessionFollowFrontierInTx(tx, {
                ...followerAck, expectedPublisherGeneration: destination.publisherGeneration + 1n,
            }))).toEqual({ ok: false, rejection: 'stale_publisher_generation' });
            await db.session.update({ where: { id: source.id }, data: { latestTurnId: 'successor' } });
            expect(await inTx(tx => acknowledgeSessionFollowFrontierInTx(tx, followerAck)))
                .toEqual({ ok: false, rejection: 'stale_terminal_turn' });
            await db.session.update({ where: { id: source.id }, data: { latestTurnId: 'current' } });
            expect(await inTx(tx => acknowledgeSessionFollowFrontierInTx(tx, followerAck)))
                .toEqual({ ok: true, delivered: followerConsumed });
            const pending = (await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
                principal, destinationSessionId: destination.id, includeManager: true,
            }))).observations.filter(row => 'relation' in row);
            expect(pending).toHaveLength(2);
            expect(pending.every(row => row.delivered.transcriptSeq === 1 && row.observed.transcriptSeq === 3)).toBe(true);
            expect(pending.find(row => row.relation === 'follower')?.delivered.turn).toEqual(follower.delivered.turn);
            const nextRepresented = pending.map(row => ({ policy: row.policy, sourceSessionId: row.sourceSessionId, relation: row.relation,
                ...(row.relation === 'manager' ? { attachedAt: row.attachedAt } : {}),
                expected: row.delivered, consumed: { ...row.delivered, transcriptSeq: 2 } }));
            const nextEventLocalId = deriveSessionFollowWakeEventLocalIdV1({ destinationSessionId: destination.id,
                publisherGeneration: destination.publisherGeneration.toString(), observations: nextRepresented });
            await db.sessionMessage.create({ data: { sessionId: destination.id, seq: 2, localId: nextEventLocalId,
                messageRole: 'event', content: { t: 'plain', v: { role: 'agent', content: { type: 'event',
                    data: TranscriptRawAgentEventV1Schema.parse({ type: 'message', message: SESSION_FOLLOW_WAKE_EVENT_MESSAGE }) } } },
                transcriptObservationProvenance: { kind: 'non_dependent', source: 'external' } } });
            expect(await setSessionManager({ accountId: account.id, sessionId: source.id, managerSessionId: null,
                expectedManagerSessionId: destination.id, authentication })).toMatchObject({ ok: true });
            expect(await setSessionManager({ accountId: account.id, sessionId: source.id, managerSessionId: destination.id,
                expectedManagerSessionId: null, authentication })).toMatchObject({ ok: true });
            // The accepted batch cannot settle even its unchanged ordinary route after reattachment.
            expect(await inTx(tx => acknowledgeSessionFollowFrontierInTx(tx, { ...followerAck,
                expected: followerConsumed, consumed: { ...followerConsumed, transcriptSeq: 2 },
                acceptance: { kind: 'context_only_wake', eventLocalId: nextEventLocalId, observations: nextRepresented },
            })))
                .toEqual({ ok: false, rejection: 'provider_acceptance_unverified' });
        } finally {
            await db.sessionMessage.deleteMany({ where: { session: { accountId: account.id } } });
            await db.sessionFollowEdge.deleteMany({ where: { sourceSession: { accountId: account.id } } });
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});

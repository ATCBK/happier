import { randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';
import { EphemeralUpdateSchema, UpdateContainerSchema } from '@happier-dev/protocol/updates';

import { createAuthenticatedFakeSocket, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { eventRouter, type ClientConnection } from '@/app/events/eventRouter';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { resolvePresenceTimeoutConfig, runPresenceTimeoutTick } from '@/app/presence/timeout';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { updateSessionMetadata } from '@/app/session/sessionWriteService';
import { db } from '@/storage/db';
import { sessionUpdateHandler } from './sessionUpdateHandler';

/** Only the socket transport is supplied; routing, access, presence and SQL stay real. */
function observeSocket(accountId: string, sessionId: string, scope: 'user-scoped' | 'session-scoped') {
    const events: Array<{ event: string; payload: unknown }> = [];
    const socket = createAuthenticatedFakeSocket({ id: randomUUID(),
        emit: vi.fn((event: string, payload: unknown) => { events.push({ event, payload }); }),
    });
    const connection: ClientConnection = scope === 'session-scoped'
        ? { connectionType: scope, socket: socket as never, userId: accountId, sessionId }
        : { connectionType: scope, socket: socket as never, userId: accountId };
    eventRouter.addConnection(accountId, connection);
    const contentEnvelopes = () => events.flatMap(event => {
        if (event.event !== 'update') return [];
        const parsed = UpdateContainerSchema.safeParse(event.payload);
        return parsed.success && parsed.data.body.t === 'update-session' && parsed.data.body.id === sessionId
            ? [parsed.data] : [];
    });
    const contentUpdates = () => contentEnvelopes().map(update => update.body);
    const activities = () => events.flatMap(event => {
        if (event.event !== 'ephemeral') return [];
        const parsed = EphemeralUpdateSchema.safeParse(event.payload);
        return parsed.success && parsed.data.type === 'activity' && parsed.data.id === sessionId
            ? [parsed.data] : [];
    });
    return { contentUpdates, contentEnvelopes, activities,
        presence: () => [...contentUpdates(), ...activities()],
        close: () => eventRouter.removeConnection(accountId, connection),
    };
}

/** Retained legacy durable-heartbeat contract required by supported older UIs. */
export async function assertLegacyKeepaliveDurableFreshness(): Promise<void> {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
    const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}' } });
    const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
        metadata: '{}', encryptionMode: 'plain', active: false, lastActiveAt: new Date(0),
        latestTurnId: 'finished-turn', latestTurnStatus: 'completed', thinking: false,
        runtimeActivityState: 'unknown', runtimeActivityActiveCount: 0,
    } });
    await db.sessionShare.create({ data: { sessionId: session.id, sharedByUserId: owner.id,
        sharedWithUserId: viewer.id, accessLevel: 'view' } });
    await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: session.id, data: 'encrypted' } });
    let clockMs = Date.now();
    const startedAt = clockMs;
    const presence = createSessionPublisherPresence({ now: () => new Date(clockMs) });
    const publisher = createAuthenticatedFakeSocket({ id: randomUUID() });
    const binding = { accountId: owner.id, machineId: machine.id, sessionId: session.id };
    const registered = await presence.registerPublisher({ socket: publisher, binding,
        completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
    expect(registered).toMatchObject({ status: 'registered' });
    sessionUpdateHandler(owner.id, publisher as never, {
        connectionType: 'session-scoped', socket: publisher, userId: owner.id, sessionId: session.id,
    } as never, { presence, binding });
    eventRouter.clearIo();
    const observers = [owner, viewer].flatMap(account => (['user-scoped', 'session-scoped'] as const)
        .map(scope => ({ accountId: account.id, scope, ...observeSocket(account.id, session.id, scope) })));
    const readSession = () => db.session.findUniqueOrThrow({ where: { id: session.id }, select: {
        active: true, lastActiveAt: true, updatedAt: true, publisherGeneration: true,
        publisherGenerationLastActiveAt: true, runtimeActivityRevision: true, latestTurnStatus: true,
        metadata: true, metadataVersion: true,
    } });
    const readCursors = async () => Promise.all([owner, viewer].map(async account => ({
        accountId: account.id,
        accountSeq: (await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).seq,
        sessionCursor: (await db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: account.id, kind: 'session', entityId: session.id },
        }, select: { cursor: true } })).cursor,
    })));
    const heartbeat = () => getSocketHandler(publisher, 'session-alive')({ sid: session.id, time: clockMs, thinking: false });
    const waitForPresence = async (active: boolean, activeAt: number) => {
        await vi.waitFor(() => {
            for (const observer of observers) expect(observer.presence(), `${observer.accountId}/${observer.scope}`)
                .toEqual(expect.arrayContaining([expect.objectContaining({ active, activeAt })]));
        });
    };
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => clockMs);
    try {
        const baseline = await readSession();
        const baselineCursors = await readCursors();
        const laterSession = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
            metadata: '{}', encryptionMode: 'plain', active: false } });
        const recencyOrder = async () => (await db.session.findMany({
            where: { id: { in: [session.id, laterSession.id] } }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            select: { id: true },
        })).map(row => row.id);
        expect(await recencyOrder()).toEqual([laterSession.id, session.id]);
        const heartbeatRows = [];
        for (const elapsed of [60_000, 120_000]) {
            clockMs = startedAt + elapsed;
            await heartbeat();
            await waitForPresence(true, clockMs);
            const row = await readSession();
            heartbeatRows.push(row);
            expect(row).toMatchObject({ active: true, lastActiveAt: new Date(clockMs),
                publisherGenerationLastActiveAt: new Date(clockMs), publisherGeneration: baseline.publisherGeneration,
                runtimeActivityRevision: baseline.runtimeActivityRevision, latestTurnStatus: 'completed' });
            const previous = heartbeatRows.length > 1 ? heartbeatRows[heartbeatRows.length - 2]! : baseline;
            expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(previous.updatedAt.getTime());
            for (const observer of observers) {
                // The durable envelope is the retained witness older clients
                // use to accept activeAt even while the Session stays online.
                expect(observer.contentEnvelopes().at(-1)).toMatchObject({ createdAt: clockMs,
                    body: { active: true, activeAt: clockMs } });
            }
        }
        const afterCursors = await readCursors();
        const cursorDeltas = afterCursors.map((row, index) => ({ accountId: row.accountId,
            accountSeq: row.accountSeq - baselineCursors[index]!.accountSeq,
            sessionCursor: row.sessionCursor - baselineCursors[index]!.sessionCursor }));
        const deliveryCounts = observers.map(observer => ({ accountId: observer.accountId, scope: observer.scope,
            content: observer.contentUpdates().length, presence: observer.activities().length }));
        expect(cursorDeltas.map(row => ({ accountSeq: row.accountSeq, sessionCursor: row.sessionCursor })))
            .toEqual([{ accountSeq: 2, sessionCursor: 2 }, { accountSeq: 2, sessionCursor: 2 }]);
        for (const observer of observers) {
            expect(observer.contentUpdates(), `content/${observer.accountId}/${observer.scope}`).toHaveLength(2);
            const ephemeralCount = observer.accountId === owner.id && observer.scope === 'user-scoped' ? 2 : 0;
            expect(observer.activities(), `presence/${observer.accountId}/${observer.scope}`).toHaveLength(ephemeralCount);
        }
        expect(await recencyOrder()).toEqual([session.id, laterSession.id]);

        // The retained durable path keeps both owner and shared viewers fresh
        // without extending expiry or hiding genuine offline/online changes.
        const timeouts = resolvePresenceTimeoutConfig({});
        const latestHeartbeat = clockMs;
        clockMs = latestHeartbeat + timeouts.sessionTimeoutMs - 1;
        await runPresenceTimeoutTick(timeouts);
        expect((await readSession()).active).toBe(true);
        clockMs += 1;
        await runPresenceTimeoutTick(timeouts);
        expect((await readSession()).active).toBe(false);
        await waitForPresence(false, latestHeartbeat);
        clockMs += 1;
        await heartbeat();
        expect((await readSession()).active).toBe(true);
        await waitForPresence(true, clockMs);
        for (const observer of observers) expect(observer.contentUpdates())
            .toEqual(expect.arrayContaining([expect.objectContaining({ active: false }), expect.objectContaining({ active: true })]));

        const beforeSemanticWrite = await readSession();
        expect(await updateSessionMetadata({ actorUserId: owner.id, sessionId: session.id,
            authentication: createPresentUserSessionAccessAuthentication(), expectedVersion: 0,
            metadataCiphertext: JSON.stringify({ path: '/semantic-change' }),
        })).toMatchObject({ ok: true, version: 1 });
        const semantic = await readSession();
        expect(semantic.updatedAt.getTime()).toBeGreaterThanOrEqual(beforeSemanticWrite.updatedAt.getTime());
        expect(await recencyOrder()).toEqual([session.id, laterSession.id]);
        const semanticCursors = await readCursors();
        clockMs += 60_000;
        await heartbeat();
        await waitForPresence(true, clockMs);
        expect(await readSession()).toMatchObject({ metadata: JSON.stringify({ path: '/semantic-change' }),
            metadataVersion: 1, publisherGeneration: semantic.publisherGeneration,
            publisherGenerationLastActiveAt: new Date(clockMs), latestTurnStatus: 'completed' });
        expect((await readSession()).updatedAt.getTime()).toBeGreaterThanOrEqual(semantic.updatedAt.getTime());
        expect(await readCursors()).toEqual(semanticCursors.map(row => ({ ...row,
            accountSeq: row.accountSeq + 1, sessionCursor: row.sessionCursor + 1 })));
    } finally {
        for (const observer of observers) observer.close();
        await getSocketHandler(publisher, 'disconnect')();
        await presence.forgetDisconnectedPublisher({ socket: publisher });
        clock.mockRestore();
    }
}

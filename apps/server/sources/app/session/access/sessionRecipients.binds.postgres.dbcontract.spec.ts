import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inReadSnapshot } from '@/storage/inTx';
import { readSessionAccountCursorAudienceInTx } from '@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx';
import { resolveCurrentSessionRecipientAccountIdsBySessionInTx } from './sessionRecipients';
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Session audience inventory bind bounds (PostgreSQL)', () => {
    const queries: Prisma.QueryEvent[] = [];
    let client: PrismaClient<Prisma.PrismaClientOptions, 'query'> | undefined;
    let originalTransaction: typeof db.$transaction;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        originalTransaction = db.$transaction;
        client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        client.$on('query', event => queries.push(event));
        await client.$connect();
        const traced = client;
        // Only the persistent transport changes; native SQL, transaction and recipient owners remain real.
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(traced.$transaction, traced, args);
        } });
    });
    afterAll(async () => {
        if (originalTransaction) db.$transaction = originalTransaction;
        await client?.$disconnect();
        await shutdownDbClient();
    });
    afterEach(() => vi.unstubAllEnvs());

    function assertBindBudget(name: string) {
        const binds = queries.map(query => (JSON.parse(query.params) as unknown[]).length);
        expect(binds.length).toBeGreaterThan(0);
        expect(Math.max(...binds)).toBeLessThanOrEqual(999);
    }

    async function fixture() {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const direct = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { id: `z-${randomUUID()}`, accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.sessionShare.create({ data: { sessionId: session.id, sharedByUserId: owner.id, sharedWithUserId: direct.id, accessLevel: 'view' } });
        // Inventory-sized selectors with one real member isolate transport binding from fixture insertion work.
        const ids = Array.from({ length: 35001 }, (_, index) => index === 35000 ? session.id : `missing-${randomUUID()}`);
        return { owner, direct, session, ids };
    }

    it('reads all requested recipient entries above the native 32767-bind boundary', async () => {
        const f = await fixture();
        queries.length = 0;
        const recipients = await inReadSnapshot(tx => resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, { sessionIds: f.ids }));
        expect(recipients.size).toBe(f.ids.length);
        expect(recipients.get(f.session.id)).toEqual([f.owner.id, f.direct.id].sort());
        expect(recipients.get(f.ids[0]!)).toEqual([]);
        assertBindBudget('recipients');
    });

    it('captures the complete cursor audience above the three-arm relation bind boundary', async () => {
        const f = await fixture();
        const earlyOwner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const createSession = (id: string, accountId: string) => db.session.create({ data: {
            id, accountId, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
        } });
        // The cursor owner sorts before chunking: a < missing-* < z forces distinct real boundaries.
        const early = await createSession(`a-${randomUUID()}`, earlyOwner.id);
        const manager = await createSession(`b-${randomUUID()}`, earlyOwner.id);
        const earlyDestination = await createSession(`x-${randomUUID()}`, earlyOwner.id);
        const lateDestination = await createSession(`y-${randomUUID()}`, f.owner.id);
        f.ids[0] = early.id;
        for (const [source, destination, relation] of [
            [early, earlyDestination, 'follower'], [f.session, lateDestination, 'follower'],
            [manager, early, 'manager'],
        ] as const) {
            await db.sessionFollowEdge.create({ data: { sourceSessionId: source.id,
                sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: source.id }),
                destinationSessionId: destination.id, relation,
                managerSourceSessionId: relation === 'manager' ? source.id : null,
                policyJson: '{"preset":"important"}',
            } });
        }
        queries.length = 0;
        const audience = await inReadSnapshot(tx => readSessionAccountCursorAudienceInTx(tx, f.ids, []));
        expect(audience.projectionSessionIds).toEqual([...f.ids, earlyDestination.id, lateDestination.id, manager.id].sort());
        expect(audience.accountIds).toEqual([f.owner.id, f.direct.id, earlyOwner.id].sort());
        assertBindBudget('cursor');
    });

    it('bounds native grant joins while retaining horizons, guest membership and fresh revocation', async () => {
        vi.stubEnv('HAPPIER_FEATURE_SHARING__SESSION_ENABLED', '1');
        const accounts = await Promise.all(Array.from({ length: 5 }, () => db.account.create({ data: { encryptionMode: 'plain' } })));
        const [owner, direct, member, guest, cutoff] = accounts;
        const effectiveAt = new Date('2026-09-01T12:00:00.000Z');
        const team = await db.team.create({ data: { name: randomUUID() } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: member!.id, role: 'member',
            sessionAccessStartsAt: new Date(effectiveAt.getTime() - 1) } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: cutoff!.id, role: 'member',
            sessionAccessStartsAt: effectiveAt } });
        const guestMembership = await db.teamMembership.create({ data: { teamId: team.id, accountId: guest!.id, role: 'guest' } });
        const groupName = randomUUID();
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: groupName, nameKey: groupName } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: guestMembership.id } });
        const ids = Array.from({ length: 1100 }, () => randomUUID());
        await db.session.createMany({ data: ids.map(id => ({ id, accountId: owner!.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' })) });
        await db.sessionShare.createMany({ data: ids.map(sessionId => ({ sessionId, sharedByUserId: owner!.id,
            sharedWithUserId: direct!.id, accessLevel: 'view' })) });
        await db.sessionTeamGrant.createMany({ data: ids.map(sessionId => ({ sessionId, teamId: team.id, accessLevel: 'view', effectiveAt })) });
        await db.sessionGroupGrant.createMany({ data: ids.map(sessionId => ({ sessionId, teamGroupId: group.id, accessLevel: 'view', effectiveAt })) });
        queries.length = 0;
        const result = await inReadSnapshot(tx => resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, { sessionIds: ids }));
        for (const id of ids) expect(result.get(id)).toEqual([owner!.id, direct!.id, member!.id, guest!.id].sort());
        assertBindBudget('native-grants');
        await db.sessionShare.deleteMany({ where: { sharedByUserId: owner!.id } });
        await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
        queries.length = 0;
        const revoked = await inReadSnapshot(tx => resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, { sessionIds: ids }));
        for (const id of ids) expect(revoked.get(id)).toEqual([owner!.id]);
        assertBindBudget('revoked-grants');
    });
});

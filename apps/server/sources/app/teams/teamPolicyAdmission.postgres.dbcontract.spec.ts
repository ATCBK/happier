import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { getDbProviderFromEnv } from '@/storage/prisma';

import { setTeamPolicyInTx } from './policy';
import { archiveTeamInTx, restoreTeamInTx } from './lifecycle';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Team authority mutation admission', () => {
    const previousRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error('A disposable PostgreSQL contract DATABASE_URL is required');
        process.env.HAPPIER_DB_TX_MAX_RETRIES = '0';
        initDbPostgres();
        await db.$connect();
    });

    afterAll(async () => {
        await shutdownDbClient();
        if (previousRetries === undefined) delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
        else process.env.HAPPIER_DB_TX_MAX_RETRIES = previousRetries;
    });

    it.each(['policy', 'archive', 'restore'] as const)('%s exclusively admits the affected Session owner before taking the Team resource lock', async operation => {
        const suffix = randomUUID();
        const reader = await db.account.create({ data: { id: `a-reader-${suffix}`, encryptionMode: 'plain' } });
        const actor = await db.account.create({ data: { id: `z-actor-${suffix}`, encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: `Admission ${suffix}`,
            ...(operation === 'restore' ? { archivedAt: new Date() } : {}) } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: 'owner' } });
        const session = await db.session.create({ data: {
            accountId: reader.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}',
        } });
        await db.sessionTeamGrant.create({ data: { sessionId: session.id, teamId: team.id, accessLevel: 'view', effectiveAt: new Date() } });
        const admitted = deferred();
        const release = deferred();
        let holderPid = 0;
        let finished = false;
        const mutate = () => inTx(async tx => {
            const input = { actorAccountId: actor.id, teamId: team.id };
            if (operation === 'archive') return archiveTeamInTx(tx, input);
            if (operation === 'restore') return restoreTeamInTx(tx, input);
            return setTeamPolicyInTx(tx, { ...input, previousAuthenticationPolicy: null, authenticationPolicy: null });
        }, { isolationLevel: 'ReadCommitted' });
        let mutationOutcome: Promise<PromiseSettledResult<Awaited<ReturnType<typeof mutate>>>[]> | undefined;
        const holderOutcome = Promise.allSettled([inTx(async tx => {
            const [backend] = await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
            holderPid = backend.pid;
            // A real ordinary content admission, with no Team or Session lock.
            await tx.$queryRawUnsafe('SELECT "id" FROM "Account" WHERE "id" = $1 FOR KEY SHARE', reader.id);
            admitted.resolve();
            await release.promise;
        })]);
        try {
            await Promise.race([admitted.promise, holderOutcome.then(() => { throw new Error('Account barrier ended before admission'); })]);
            mutationOutcome = Promise.allSettled([mutate().finally(() => { finished = true; })]);
            let blocked: Array<{ pid: number; query: string }> = [];
            while (!finished && blocked.length === 0) {
                blocked = await db.$queryRawUnsafe<Array<{ pid: number; query: string }>>(
                    'SELECT pid, query FROM pg_stat_activity WHERE datname = current_database() '
                    + 'AND $1::int = ANY(pg_blocking_pids(pid))', holderPid,
                );
            }
            // Waiting only at terminal publication is too late: that would
            // leave a resource-to-Account inverse against Session deletion.
            expect(blocked, 'Credential authority must wait at exclusive Account entry').toHaveLength(1);
            expect(blocked[0].query).toMatch(/Account.*FOR UPDATE/s);
            await db.$transaction(async probe => {
                await probe.$queryRawUnsafe('SELECT "id" FROM "Team" WHERE "id" = $1 FOR UPDATE NOWAIT', team.id);
            });
            release.resolve();
            const [outcome] = await mutationOutcome;
            if (outcome.status === 'rejected') throw outcome.reason;
            expect(outcome.value).toMatchObject({ ok: true });
            if (operation === 'policy') {
                expect(await db.accountChange.count({ where: { accountId: reader.id, kind: 'session', entityId: session.id } })).toBeGreaterThan(0);
            } else {
                const persisted = await db.team.findUniqueOrThrow({ where: { id: team.id } });
                if (operation === 'archive') expect(persisted.archivedAt).not.toBeNull();
                else expect(persisted.archivedAt).toBeNull();
                expect(await db.session.findUnique({ where: { id: session.id } })).not.toBeNull();
            }
        } finally {
            release.resolve();
            await holderOutcome;
            await mutationOutcome;
            await db.session.deleteMany({ where: { id: session.id } });
            await db.team.deleteMany({ where: { id: team.id } });
            await db.account.deleteMany({ where: { id: { in: [actor.id, reader.id] } } });
        }
    });
});

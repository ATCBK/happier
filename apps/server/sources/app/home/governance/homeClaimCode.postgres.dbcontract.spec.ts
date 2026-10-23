import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';

import { HOME_CLAIM_CODE_CACHE_KEY, mintHomeClaimCode, redeemHomeClaimCode } from './homeClaimCode';
import { claimHomeOwner } from './ownerAssignment';

function deferred() {
    let resolve!: () => void;
    return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Home claim code cache contention', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it('replaces a concurrently changed code while redemption still refuses an intervening owner claim', async () => {
        const candidate = await db.account.create({ data: { publicKey: `claim-code-${randomUUID()}`, encryptionMode: 'plain' } });
        const held = deferred(), resume = deferred();
        let peerPid = 0;
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        const replacing = inTx(async tx => {
            await tx.simpleCache.upsert({ where: { key: HOME_CLAIM_CODE_CACHE_KEY },
                create: { key: HOME_CLAIM_CODE_CACHE_KEY, value: 'replaced-code' }, update: { value: 'replaced-code' } });
            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            peerPid = pid;
            held.resolve();
            await resume.promise;
        });
        await held.promise;
        const minting = mintHomeClaimCode();
        const outcome = minting.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
        try {
            await expect.poll(async () => {
                const [{ blocked }] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                    SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                        AND ${peerPid} = ANY(pg_blocking_pids(pid))) AS blocked
                `;
                return blocked;
            }).toBe(true);
            expect(await claimHomeOwner({ targetAccountId: candidate.id }))
                .toEqual({ status: 'claimed', ownerAccountId: candidate.id });
        } finally {
            resume.resolve();
            await replacing;
        }
        try {
            const result = await outcome;
            expect(result).toMatchObject({ ok: true, value: { status: 'minted' } });
            if (!result.ok) throw result.error;
            if (result.value.status !== 'minted') throw new Error('Mint did not replace the stale code');
            expect((await db.simpleCache.findUniqueOrThrow({ where: { key: HOME_CLAIM_CODE_CACHE_KEY } })).value)
                .not.toContain(result.value.code);
            expect(await redeemHomeClaimCode({ accountId: candidate.id, code: result.value.code })).toEqual({ status: 'refused' });
            expect(await mintHomeClaimCode()).toEqual({ status: 'already_owned' });
            expect(await db.account.findMany({ where: { homeRole: 'owner', status: 'active' }, select: { id: true } }))
                .toEqual([{ id: candidate.id }]);
        } finally {
            vi.unstubAllEnvs();
            await db.simpleCache.deleteMany({ where: { key: HOME_CLAIM_CODE_CACHE_KEY } });
            await db.account.delete({ where: { id: candidate.id } });
        }
    });
});

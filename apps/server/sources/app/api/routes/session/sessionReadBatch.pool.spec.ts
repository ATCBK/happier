import { afterEach, describe, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { SessionReadBatchResponseV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { inTxPostgresControlStatementMock } from '@/app/api/testkit/dbMocks';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionReadBatchRoute } from './registerSessionReadBatchRoute';
import type { Tx } from '@/storage/inTx';

const pool = vi.hoisted(() => ({ limit: 1, active: 0, peak: 0 }));
vi.mock('@/storage/db', async () => ({
    ...await vi.importActual<typeof import('@/storage/db')>('@/storage/db'),
    db: { $transaction: async <T>(read: (tx: Tx) => Promise<T>) => {
        if (pool.active >= pool.limit) throw Object.assign(new Error('Pool acquisition timeout'), { code: 'P2024' });
        pool.active += 1;
        pool.peak = Math.max(pool.peak, pool.active);
        // Genuine Prisma transaction/pool boundary; route, admission and inTx stay real.
        const tx = { ...inTxPostgresControlStatementMock,
            session: { findUnique: async () => { await setImmediate(); return null; } },
        } as unknown as Tx;
        try { return await read(tx); } finally { pool.active -= 1; }
    } },
}));

describe('Session batch database pool admission', () => {
    afterEach(() => { vi.unstubAllEnvs(); });

    it.each([
        { limit: 2, urlLimit: 2, override: undefined },
        { limit: 3, urlLimit: 1, override: '3' },
    ])('keeps every per-id outcome within the configured $limit-connection pool', async ({ limit, urlLimit, override }) => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        vi.stubEnv('DATABASE_URL', `postgresql://fixture:fixture@localhost/fixture?connection_limit=${urlLimit}`);
        vi.stubEnv('HAPPIER_DB_CONNECTION_LIMIT', override ?? '');
        vi.stubEnv('HAPPY_DB_CONNECTION_LIMIT', '');
        Object.assign(pool, { limit, active: 0, peak: 0 });
        const sessionIds = Array.from({ length: limit * 4 + 1 }, (_, index) => `missing-${index}`);
        await withAuthenticatedTestApp(registerSessionReadBatchRoute, async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch',
                headers: { 'x-test-user-id': 'owner', 'x-happier-account-stored-content-protocol': '4' },
                payload: { sessionIds, accessProjectionVersion: 1 } });
            expect(response.statusCode).toBe(200);
            const { results } = SessionReadBatchResponseV1Schema.parse(response.json());
            expect(results.map(result => result.sessionId)).toEqual(sessionIds);
            expect(results.map(result => result.detail?.status)).toEqual(sessionIds.map(() => 404));
            expect(pool.peak).toBeGreaterThan(0);
            expect(pool.peak).toBeLessThan(limit);
            expect(pool.active).toBe(0);
        });
    });
});

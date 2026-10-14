import Fastify from 'fastify';
import { serializerCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import { installDbModuleMock } from '../testkit/dbMocks';

const transaction = vi.fn();
// Fail the database boundary, preserving real retry exhaustion and HTTP projection.
installDbModuleMock({ db: { $transaction: transaction } });
const { inTx } = await import('@/storage/inTx');
const { enableErrorHandlers } = await import('./enableErrorHandlers');

describe('HTTP transaction conflict projection', () => {
    afterEach(() => { vi.unstubAllEnvs(); transaction.mockReset(); });

    it('projects exhausted rollback once as typed 503 despite a narrow route response schema', async () => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        transaction.mockRejectedValue(Object.assign(new Error('private SQL contents'), { code: 'P2034' }));
        const app = Fastify({ logger: false });
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>();
        enableErrorHandlers(typed as Parameters<typeof enableErrorHandlers>[0]);
        typed.post('/conflicting-write', {
            schema: { response: { 200: z.object({ success: z.literal(true) }) } },
        }, async () => inTx(async () => ({ success: true as const })));
        try {
            const response = await app.inject({ method: 'POST', url: '/conflicting-write' });
            expect(response.statusCode).toBe(503);
            expect(response.json()).toEqual({ error: 'database_transaction_conflict_exhausted', statusCode: 503 });
            expect(response.body).not.toContain('private SQL contents');
        } finally {
            await app.close();
        }
    });

    it('does not turn an unclassified driver failure into a certain rollback response', async () => {
        const app = Fastify({ logger: false });
        enableErrorHandlers(app as Parameters<typeof enableErrorHandlers>[0]);
        app.post('/unclassified-write', async () => { throw Object.assign(new Error('unknown outcome'), { code: 'P2034' }); });
        try {
            const response = await app.inject({ method: 'POST', url: '/unclassified-write' });
            expect(response.statusCode).toBe(500);
            expect(response.json().error).toBe('Internal Server Error');
        } finally {
            await app.close();
        }
    });
});

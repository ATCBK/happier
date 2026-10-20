import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDbModuleMock } from '@/app/api/testkit/dbMocks';
import { PROVIDER_CONNECTIONS_ROWS_ROUTE_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';

const transaction = vi.fn();
const foreignSecret = vi.fn();
// The database boundary supplies isolation and rollback evidence; route/domain logic stays real.
installDbModuleMock({ db: { $transaction: transaction, savedSecretResource: { findFirst: foreignSecret } } });
const { createAuthenticatedTestApp } = await import('@/app/api/testkit/sqliteFastify');
const { registerProviderConnectionsRoutes } = await import('./registerProviderConnectionsRoutes');

describe('Provider catalog transaction admission', () => {
    afterEach(() => { transaction.mockReset(); foreignSecret.mockReset(); vi.unstubAllEnvs(); });

    it.each(['GET', 'POST'] as const)('preserves confirmed rollback as typed transient HTTP for %s', async method => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        transaction.mockRejectedValue(Object.assign(new Error('private database diagnostic'), { code: 'P2034' }));
        const app = createAuthenticatedTestApp();
        registerProviderConnectionsRoutes(app);
        try {
            const response = await app.inject({ method, url: PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
                headers: { 'x-test-user-id': 'provider-account' },
                ...(method === 'POST' ? { payload: { expectedRevision: 1, content: null,
                    referencedSavedSecretIds: [], savedSecretRevisions: [] } } : {}),
            });
            expect(response.statusCode).toBe(503);
            expect(response.json()).toEqual({ error: 'database_transaction_conflict_exhausted', statusCode: 503 });
            expect(response.body).not.toContain('private database diagnostic');
        } finally { await app.close(); }
    });

    it.each([
        { method: 'GET' as const, references: [], foreign: false, isolation: 'RepeatableRead' },
        { method: 'POST' as const, references: [], foreign: false, isolation: 'ReadCommitted' },
        { method: 'POST' as const, references: ['happier:shared-secret:v1:secret'], foreign: false, isolation: 'ReadCommitted' },
        { method: 'POST' as const, references: ['happier:shared-secret:v1:secret'], foreign: true, isolation: 'Serializable' },
    ])('uses $isolation for $method with references $references (foreign: $foreign)', async ({ method, references, foreign, isolation }) => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        foreignSecret.mockResolvedValue(foreign ? { id: 'secret' } : null);
        const isolationLevels: unknown[] = [];
        transaction.mockImplementation(async (callback, options) => {
            isolationLevels.push(options.isolationLevel);
            return callback({
                $queryRaw: async () => [{ statement_timeout: '0' }],
                $executeRaw: async () => 0,
                $executeRawUnsafe: async () => 0,
                $queryRawUnsafe: async () => [],
                account: { findUnique: async () => null },
            });
        });
        const app = createAuthenticatedTestApp();
        registerProviderConnectionsRoutes(app);
        try {
            const response = await app.inject({ method, url: PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
                headers: { 'x-test-user-id': 'missing-provider-account' },
                ...(method === 'POST' ? { payload: { expectedRevision: 1, content: null,
                    referencedSavedSecretIds: references, savedSecretRevisions: [] } } : {}),
            });
            expect(response.json()).toEqual({ status: 'account-not-found' });
            expect(isolationLevels).toEqual([isolation]);
        } finally { await app.close(); }
    });
});

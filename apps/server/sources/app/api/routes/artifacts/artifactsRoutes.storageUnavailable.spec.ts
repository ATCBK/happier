import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installDbModuleMock } from '../../testkit/dbMocks';

const transaction = vi.fn();
// Substitute the persistent connection, retaining real Artifact reads and HTTP error projection.
installDbModuleMock({ db: { $transaction: transaction } });

const { createAuthenticatedTestApp } = await import('../../testkit/sqliteFastify');
const { artifactsRoutes } = await import('./artifactsRoutes');
const { registerSessionListingRoutes } = await import('../session/registerSessionListingRoutes');

describe('prompt preparation storage unavailability', () => {
    beforeEach(() => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        transaction.mockRejectedValue(Object.assign(
            new Error('Timed out fetching a new connection from the connection pool; private database details'),
            { code: 'P2024' },
        ));
    });

    afterEach(() => {
        transaction.mockReset();
        vi.unstubAllEnvs();
    });

    it.each([
        { method: 'GET', url: '/v1/artifacts' },
        { method: 'GET', url: '/v1/artifacts/preparation-artifact' },
        { method: 'POST', url: '/v1/artifacts/read', payload: { artifactIds: ['preparation-artifact'] } },
        { method: 'GET', url: '/v2/sessions/preparation-session' },
    ] as const)('projects pool exhaustion through $method $url as typed 503', async request => {
        const app = createAuthenticatedTestApp();
        artifactsRoutes(app);
        registerSessionListingRoutes(app);
        try {
            const response = await app.inject({ ...request, headers: { 'x-test-user-id': 'account-1' } });
            expect(response.statusCode).toBe(503);
            expect(response.json()).toEqual({ error: 'database_connection_unavailable', statusCode: 503 });
            expect(response.body).not.toContain('private');
            expect(response.body).not.toContain('P2024');
        } finally {
            await app.close();
        }
    });

    it('retains the typed invalid Artifact cursor response before storage admission', async () => {
        const app = createAuthenticatedTestApp();
        artifactsRoutes(app);
        try {
            const response = await app.inject({ method: 'GET', url: '/v1/artifacts?cursor=invalid',
                headers: { 'x-test-user-id': 'account-1' } });
            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ error: 'Failed to get artifacts' });
        } finally {
            await app.close();
        }
    });
});

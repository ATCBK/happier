import { describe, expect, it } from 'vitest';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerAccountPublicProfileRoutes } from './registerAccountPublicProfileRoutes';

describe('Account embed transport admission', () => {
    it('protects captured Account reads and rejects caller-selected Accounts or private facts before reading storage', async () => {
        await withAuthenticatedTestApp(registerAccountPublicProfileRoutes, async app => {
            for (const url of ['/v1/account/public-profile/view', '/v1/account/public-profile/embed?kind=card&theme=auto&syntax=picture']) {
                expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
            }
            for (const url of ['/v1/account/public-profile/view?accountId=someone-else',
                '/v1/account/public-profile/embed?kind=card&theme=auto&syntax=picture&metric=tokens&snapshot=private']) {
                expect((await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': 'captured-account' } })).statusCode).toBe(400);
            }
        });
    });
});

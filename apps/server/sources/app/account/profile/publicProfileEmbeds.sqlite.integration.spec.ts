import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerAccountPublicProfileRoutes } from '@/app/api/routes/account/registerAccountPublicProfileRoutes';

describe('captured Account public-profile embeds', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-profile-embed-',
        env: { NODE_OPTIONS: [process.env.NODE_OPTIONS, '--conditions=happier-source'].filter(Boolean).join(' ') } }); }, 120_000);
    afterAll(async () => { await harness?.close(); });
    afterEach(async () => { harness.restoreEnv(); await db.account.deleteMany(); });

    it('has a real authenticated typed read and cannot turn an unpublished Account into a shareable profile', async () => {
        const account = await db.account.create({ data: { publicKey: 'embed-owner', username: 'embed_owner' } });
        await withAuthenticatedTestApp(registerAccountPublicProfileRoutes, async app => {
            const url = '/v1/account/public-profile/embed?kind=card&theme=auto&syntax=picture';
            expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
            const response = await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': account.id } });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ kind: 'unavailable', reason: 'not_published' });
            expect(await db.accountPublicProfile.count()).toBe(0);
            const forged = await app.inject({ method: 'GET', url: `${url}&metric=tokens&snapshot=private`, headers: { 'x-test-user-id': account.id } });
            expect(forged.statusCode).toBe(400);
        });
    });

    it('reads only the captured Account public view and cannot accept another Account or private snapshot', async () => {
        const account = await db.account.create({ data: { publicKey: 'embed-view-owner', username: 'view_owner' } });
        await withAuthenticatedTestApp(registerAccountPublicProfileRoutes, async app => {
            const url = '/v1/account/public-profile/view';
            expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
            const response = await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': account.id } });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ kind: 'unavailable' });
            expect((await app.inject({ method: 'GET', url: `${url}?accountId=someone-else`, headers: { 'x-test-user-id': account.id } })).statusCode).toBe(400);
            expect(await db.accountPublicProfile.count()).toBe(0);
        });
    });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerPublicProfileReadRoutes } from '@/app/api/routes/account/registerPublicProfileReadRoutes';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

describe('anonymous public-profile delivery', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-profile-delivery-' }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('serves a cold anonymous HTML unavailable state without an optional UI mount', async () => {
        await withAuthenticatedTestApp(app => registerPublicProfileReadRoutes(app), async app => {
            const response = await app.inject({ method: 'GET', url: '/@missing_profile', headers: { 'if-none-match': '*' } });
            expect(response.statusCode).toBe(404);
            expect(response.headers['content-type']).toContain('text/html');
            expect(response.body).toContain('Profile unavailable');
            expect(response.headers.etag).toBeUndefined();
        });
    });

    it('serves indistinguishable unavailable embed canvases and a strict Shields envelope for unknown or hidden metrics', async () => {
        await withAuthenticatedTestApp(app => registerPublicProfileReadRoutes(app), async app => {
            for (const path of ['/badge/tokens.svg', '/badge/unknown.svg', '/card.svg']) {
                const response = await app.inject({ method: 'GET', url: `/@missing_profile${path}`, headers: { 'if-none-match': '*' } });
                expect(response.statusCode).toBe(200);
                expect(response.headers['content-type']).toContain('image/svg+xml');
                expect(response.body).toContain('Profile unavailable');
                expect(response.headers.etag).toBeUndefined();
                expect(response.headers['x-robots-tag']).toContain('noindex');
            }
            const shield = await app.inject({ method: 'GET', url: '/@missing_profile/badge/tokens.json' });
            expect(shield.statusCode).toBe(200);
            expect(shield.json()).toEqual({ schemaVersion: 1, label: 'Happier', message: 'Profile unavailable', color: '6c6c70', isError: true });
            const image = await app.inject({ method: 'GET', url: '/@missing_profile/og.png?v=old' });
            expect(image.statusCode).toBe(200);
            expect(image.headers['content-type']).toContain('image/png');
            expect(image.rawPayload.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        });
    });

    it('keeps a missing publication background unavailable before considering an old image validator', async () => {
        await withAuthenticatedTestApp(app => registerPublicProfileReadRoutes(app), async app => {
            const response = await app.inject({ method: 'GET', url: '/@missing_profile/background', headers: { 'if-none-match': '*' } });
            expect(response.statusCode).toBe(404);
            expect(response.json()).toEqual({ kind: 'unavailable' });
            expect(response.headers.etag).toBeUndefined();
        });
    });
});

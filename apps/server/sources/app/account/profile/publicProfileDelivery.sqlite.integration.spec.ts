import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerPublicProfileReadRoutes } from '@/app/api/routes/account/registerPublicProfileReadRoutes';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { loadSharp } from '@/storage/blob/sharpRuntime';
import { db } from '@/storage/db';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, PublicProfilePublishBodyV1Schema, PublicProfileReadResultV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { registerAccountPublicProfileRoutes } from '@/app/api/routes/account/registerAccountPublicProfileRoutes';

describe('anonymous public-profile delivery', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-profile-delivery-', env: {
        HAPPIER_PUBLIC_SERVER_URL: 'https://profiles.example/prefix', HAPPIER_PUBLIC_PROFILE_REPORT_URL: 'mailto:operator@example.test',
    } }); }, 120_000);
    afterAll(async () => { await harness?.close(); });
    afterEach(async () => { harness.restoreEnv(); await db.account.deleteMany(); });

    it('publishes through the actual feature-admitted HTTP owner and revalidates every output after hide and withdrawal', async () => {
        const account = await db.account.create({ data: { publicKey: 'public-profile-delivery-owner', username: 'delivery_owner', name: 'Delivery Owner' } });
        const candidate = PublicProfilePublishBodyV1Schema.parse({ policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadata: {}, projectSelections: [],
            query: normalizeUsageQuery({ population: 'public_eligible_personal', period: { startMs: 1000, endMs: 2000 }, timeZoneOffsetMinutes: 0 }),
            snapshot: { v: 1, computedAtMs: 2000, period: { startMs: 1000, endMs: 2000, timeZoneOffsetMinutes: 0 },
                coverage: { status: 'partial', method: 'runtime' }, fieldCoverage: {}, facts: { tokens: 987654321, activeDays: 2 } },
            appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
            layout: { v: 1, items: [{ kind: 'widget', id: 'token-figure', size: 'medium', frameStyle: 'plain',
                presentation: { kind: 'declarative', document: { version: 1, root: { kind: 'metric', label: 'Tokens',
                    data: { kind: 'value', value: { kind: 'public_profile' } }, value: { path: ['snapshot', 'facts', 'tokens'], type: 'number' } } } } }] } });
        await withAuthenticatedTestApp(app => { registerAccountPublicProfileRoutes(app); registerPublicProfileReadRoutes(app); }, async app => {
            const headers = { 'x-test-user-id': account.id };
            const published = await app.inject({ method: 'POST', url: '/v1/account/public-profile/publish', headers, payload: candidate });
            expect(published.statusCode).toBe(200);
            expect(published.json()).toMatchObject({ kind: 'updated', record: { state: 'published' } });
            const paths = ['/v1/public/profiles/delivery_owner', '/@delivery_owner', '/@delivery_owner/badge/tokens.svg',
                '/@delivery_owner/card.svg', '/@delivery_owner/card.png?theme=dark', '/@delivery_owner/og.png?v=old'];
            const validators = new Map<string, string>();
            for (const url of paths) {
                const response = await app.inject({ method: 'GET', url });
                expect(response.statusCode, url).toBe(200);
                expect(typeof response.headers.etag, url).toBe('string');
                const etag = String(response.headers.etag);
                validators.set(url, etag);
                const unchanged = await app.inject({ method: 'GET', url, headers: { 'if-none-match': etag } });
                expect(unchanged.statusCode, url).toBe(304);
                expect(unchanged.body).toBe('');
            }
            const hidden = structuredClone(candidate.policy);
            hidden.fields.tokens = false;
            const applied = await app.inject({ method: 'PUT', url: '/v1/account/public-profile/policy', headers, payload: { policy: hidden } });
            expect(applied.json().kind).toBe('updated');
            for (const url of paths) {
                const response = await app.inject({ method: 'GET', url, headers: { 'if-none-match': validators.get(url)! } });
                expect(response.statusCode, url).toBe(200);
                expect(response.headers.etag, url).not.toBe(validators.get(url));
                if (url.startsWith('/v1/')) {
                    const current = PublicProfileReadResultV1Schema.parse(response.json());
                    expect(current.kind).toBe('published');
                    if (current.kind === 'published') expect(current.view.snapshot.facts.tokens).toBeUndefined();
                }
                expect(response.body, url).not.toContain('987654321');
            }
            const withdrawn = await app.inject({ method: 'DELETE', url: '/v1/account/public-profile', headers });
            expect(withdrawn.json()).toEqual({ kind: 'updated', record: null });
            for (const url of paths) {
                const response = await app.inject({ method: 'GET', url, headers: { 'if-none-match': validators.get(url)! } });
                expect(response.statusCode, url).toBe(url === '/@delivery_owner' || url.startsWith('/v1/') ? 404 : 200);
                expect(response.headers.etag, url).toBeUndefined();
            }
        });
    });

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
            for (const [path, width, height] of [['/card.png?theme=dark', 495, 195], ['/og.png?v=old', 1200, 630]] as const) {
                const image = await app.inject({ method: 'GET', url: `/@missing_profile${path}`, headers: { 'if-none-match': '*' } });
                expect(image.statusCode, path).toBe(200);
                expect(image.headers['content-type']).toContain('image/png');
                expect(image.rawPayload.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
                expect(await (await loadSharp())(image.rawPayload).metadata()).toMatchObject({ width, height });
                expect(image.headers.etag).toBeUndefined();
            }
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

import { describe, expect, it } from 'vitest';
import { createUiRegistryHttpV1 } from './registryHttpV1';
import { RegistrySourceStatusV1Schema } from '@happier-dev/protocol/registries';

describe('UI registry HTTP boundary', () => {
    it('reaches an upstream authentication failure once the origin rate limit clears', async () => {
        let now = 1_000;
        let calls = 0;
        const http = createUiRegistryHttpV1(async () => ++calls === 1
            ? new Response(null, { status: 429, headers: { 'retry-after': '2' } })
            : new Response(null, { status: 401 }), undefined, () => now);
        expect(await http.getJson('https://registry-expiry.test/catalog')).toMatchObject({ status: { state: 'rate_limited', retryAt: 3_000 } });
        now = 2_999;
        expect(await http.getJson('https://registry-expiry.test/catalog')).toMatchObject({ status: { state: 'rate_limited' } });
        expect(calls).toBe(1);
        now = 3_000;
        expect(await http.getJson('https://registry-expiry.test/catalog')).toEqual({ ok: false, status: { state: 'auth_failed' } });
        expect(calls).toBe(2);
    });
    it('admits a headerless rate limit and lets a manual retry reach the upstream', async () => {
        let calls = 0;
        const http = createUiRegistryHttpV1(async () => ++calls === 1
            ? new Response('', { status: 429 }) : Response.json({ items: [] }));
        const response = await http.getJson('https://headerless-rate.example/index');
        expect(response).toEqual({ ok: false, status: { state: 'rate_limited' } });
        if (response.ok) throw new Error('Expected rate-limit observation');
        expect(RegistrySourceStatusV1Schema.parse(response.status)).toEqual({ state: 'rate_limited' });
        expect(await http.getJson('https://headerless-rate.example/index')).toMatchObject({ ok: true, value: { items: [] } });
        expect(calls).toBe(2);
    });
    it('retains transport TypeError for the protocol placement fallback and propagates cancellation', async () => {
        const network = new TypeError('Failed to fetch');
        const http = createUiRegistryHttpV1(async () => { throw network; });
        await expect(http.getJson('https://example.com/index.json')).rejects.toBe(network);
        const abort = new DOMException('Cancelled', 'AbortError');
        await expect(createUiRegistryHttpV1(async () => { throw abort; }).getText('https://example.com')).rejects.toBe(abort);
    });

    it('reports per-source rate limits and authentication failures without inventing empty content', async () => {
        const http = createUiRegistryHttpV1(async () => new Response('', { status: 429,
            headers: { 'retry-after': '120' } }), undefined, () => 1_000);
        expect(await http.getJson('https://example.com/index.json')).toEqual({ ok: false,
            status: { state: 'rate_limited', retryAt: 121_000 } });
        expect(await createUiRegistryHttpV1(async () => new Response('', { status: 403 })).getText('https://example.com'))
            .toEqual({ ok: false, status: { state: 'auth_failed' } });
        expect(await createUiRegistryHttpV1(async () => new Response('', { status: 403,
            headers: { 'x-ratelimit-remaining': '0' } })).getJson('https://api.github.com/index'))
            .toEqual({ ok: false, status: { state: 'rate_limited' } });
        expect(await createUiRegistryHttpV1(async () => new Response('', { status: 404 })).getJson('https://example.com/plugin.json'))
            .toEqual({ ok: false, status: { state: 'invalid_source' } });
    });

    it('never materializes a source token in the UI', async () => {
        let called = false;
        const http = createUiRegistryHttpV1(async () => { called = true; return new Response('{}'); });
        expect(await http.getJson('https://example.com', { source: { id: 'private', title: 'Private',
            format: 'git', kinds: ['skill'], url: 'https://example.com', enabled: true, addedAt: 0,
            token: { secretRef: 'opaque-secret-reference' } } })).toEqual({ ok: false, status: { state: 'auth_failed' } });
        expect(called).toBe(false);
    });
});

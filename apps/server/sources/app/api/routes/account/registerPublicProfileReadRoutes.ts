import type { Fastify } from '../../types';
import { createHash } from 'node:crypto';
import { z } from 'zod/mini';
import { PublicProfileReadResultV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { readRequestHomeEnv } from '@/app/home/settings/requestHomeEnv';
import { readPublicProfile, readPublicProfileDelivery, type PublicProfileDelivery } from '@/app/account/profile/publicProfileRead';
import type { PublicProfileServerDependencies } from '@/app/account/profile/publicProfileStorage';
import { publicProfileServerDependencies } from '@/app/account/profile/publicProfileDependencies';
import { renderPublicProfileHtml } from '@/app/account/profile/render/publicProfileHtml';
import { renderPublicProfileSvg, publicProfileBadgeMessage } from '@/app/account/profile/render/publicProfileSvg';
import { renderPublicProfileCardPng, renderPublicProfileOg } from '@/app/account/profile/render/publicProfileOg';
import { PUBLIC_PROFILE_ASSET_LABELS } from '@/app/account/profile/render/publicProfileLabels';
import { PUBLIC_PROFILE_PALETTES } from '@/app/account/profile/render/publicProfileEnvironment';
import { publicProfileFontFaceForFilename, readPublicProfileFont } from '@/app/account/profile/render/publicProfileFonts';

/** Validators describe the currently admitted representation, never a stored snapshot timestamp. */
export function publicProfileRepresentationEtag(bytes: string | Uint8Array): string {
    return `"${createHash('sha256').update(bytes).digest('hex')}"`;
}

export function matchesPublicProfileEtag(value: string | string[] | undefined, etag: string): boolean {
    const values = Array.isArray(value) ? value : [value ?? ''];
    return values.flatMap(value => value.split(',')).some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag);
}

/** Anonymous output is independent of optional UI mounting and caller credentials. */
export function registerPublicProfileReadRoutes(app: Fastify, deps: PublicProfileServerDependencies = publicProfileServerDependencies): void {
    app.get('/v1/public/profiles/assets/fonts/:filename', { schema: { params: z.strictObject({ filename: z.string() }) } }, async (request, reply) => {
        reply.header('X-Content-Type-Options', 'nosniff').header('X-Robots-Tag', 'noindex');
        const face = publicProfileFontFaceForFilename(request.params.filename);
        if (!face) return reply.code(404).send({ kind: 'unavailable' });
        try {
            const font = await readPublicProfileFont(face);
            const etag = publicProfileRepresentationEtag(font.bytes);
            reply.header('Cache-Control', 'public, no-cache, must-revalidate').header('ETag', etag)
                .type(request.params.filename.endsWith('.otf') ? 'font/otf' : 'font/ttf');
            if (matchesPublicProfileEtag(request.headers['if-none-match'], etag)) return reply.code(304).send();
            return reply.send(font.bytes);
        } catch { return reply.header('Cache-Control', 'no-store').code(503).send({ kind: 'unavailable' }); }
    });
    const assetOptions = { labels: PUBLIC_PROFILE_ASSET_LABELS, palette: PUBLIC_PROFILE_PALETTES };
    const assetQuery = z.object({ theme: z.optional(z.enum(['auto', 'light', 'dark'])) });
    for (const kind of ['badge', 'card'] as const) {
        const path = kind === 'badge' ? '/@:handle/badge/:kind.svg' : '/@:handle/card.svg';
        app.get(path, { schema: { params: z.object({ handle: z.string(), kind: z.optional(z.string()) }), querystring: assetQuery } }, async (request, reply) => {
            reply.header('X-Content-Type-Options', 'nosniff').header('X-Robots-Tag', 'noindex').header('Referrer-Policy', 'no-referrer')
                .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
            try {
                const env = await readRequestHomeEnv(request);
                // A metric badge has no picture layer, just like its Shields JSON counterpart.
                const delivery: PublicProfileDelivery = kind === 'badge'
                    ? { result: await readPublicProfile(request.params.handle, env, deps) }
                    : await readPublicProfileDelivery(request.params.handle, env, deps);
                const body = await renderPublicProfileSvg(delivery.result, { ...assetOptions, kind, theme: request.query.theme ?? 'auto',
                    metric: request.params.kind, ...(delivery.picture ? { picture: delivery.picture.bytes } : {}) });
                reply.header('Cache-Control', 'public, no-cache, must-revalidate').type('image/svg+xml');
                if (delivery.result.kind === 'unavailable') return reply.send(body);
                const etag = publicProfileRepresentationEtag(body);
                reply.header('ETag', etag);
                if (matchesPublicProfileEtag(request.headers['if-none-match'], etag)) return reply.code(304).send();
                return reply.send(body);
            } catch { return reply.header('Cache-Control', 'no-store').code(503).send({ kind: 'unavailable' }); }
        });
    }
    app.get('/@:handle/badge/:kind.json', { schema: { params: z.strictObject({ handle: z.string(), kind: z.string() }) } }, async (request, reply) => {
        reply.header('X-Content-Type-Options', 'nosniff').header('X-Robots-Tag', 'noindex').header('Referrer-Policy', 'no-referrer');
        try {
            const result = await readPublicProfile(request.params.handle, await readRequestHomeEnv(request), deps);
            const message = publicProfileBadgeMessage(result, request.params.kind, PUBLIC_PROFILE_ASSET_LABELS);
            const body = { schemaVersion: 1, label: PUBLIC_PROFILE_ASSET_LABELS.brand, message: message.message,
                color: PUBLIC_PROFILE_PALETTES.light.secondary.replace('#', ''), ...(message.isError ? { isError: true } : {}) };
            reply.header('Cache-Control', 'public, no-cache, must-revalidate');
            if (result.kind === 'unavailable') return reply.send(body);
            const etag = publicProfileRepresentationEtag(JSON.stringify(body));
            reply.header('ETag', etag);
            if (matchesPublicProfileEtag(request.headers['if-none-match'], etag)) return reply.code(304).send();
            return reply.send(body);
        } catch { return reply.header('Cache-Control', 'no-store').code(503).send({ kind: 'unavailable' }); }
    });
    for (const kind of ['card', 'og'] as const) {
    app.get(`/@:handle/${kind}.png`, { schema: { params: z.strictObject({ handle: z.string() }),
        querystring: z.object({ v: z.optional(z.string()), theme: z.optional(z.enum(['auto', 'light', 'dark'])) }) } }, async (request, reply) => {
        reply.header('X-Content-Type-Options', 'nosniff').header('X-Robots-Tag', 'noindex').header('Referrer-Policy', 'no-referrer');
        try {
            const delivery = await readPublicProfileDelivery(request.params.handle, await readRequestHomeEnv(request), deps);
            const options = { ...assetOptions, ...(delivery.picture ? { picture: delivery.picture.bytes } : {}) };
            const body = kind === 'og' ? await renderPublicProfileOg(delivery.result, options)
                : await renderPublicProfileCardPng(delivery.result, { ...options, theme: request.query.theme ?? 'auto' });
            reply.header('Cache-Control', 'public, no-cache, must-revalidate').type('image/png');
            if (delivery.result.kind === 'unavailable') return reply.send(body);
            const etag = publicProfileRepresentationEtag(body);
            reply.header('ETag', etag);
            if (matchesPublicProfileEtag(request.headers['if-none-match'], etag)) return reply.code(304).send();
            return reply.send(body);
        } catch { return reply.header('Cache-Control', 'no-store').code(503).send({ kind: 'unavailable' }); }
    });
    }
    app.get('/@:handle/background', { schema: { params: z.strictObject({ handle: z.string() }), querystring: z.strictObject({}) } }, async (request, reply) => {
        reply.header('X-Content-Type-Options', 'nosniff').header('X-Robots-Tag', 'noindex').header('Referrer-Policy', 'no-referrer');
        try {
            const delivery = await readPublicProfileDelivery(request.params.handle, await readRequestHomeEnv(request), deps);
            const atmosphere = delivery.result.kind === 'published' ? delivery.result.view.appearance.atmosphere : null;
            if (atmosphere?.source !== 'picture' || !delivery.picture) {
                return reply.header('Cache-Control', 'public, no-cache, must-revalidate').code(404).send({ kind: 'unavailable' });
            }
            const etag = publicProfileRepresentationEtag(Buffer.concat([Buffer.from(atmosphere.picture.ref.id), delivery.picture.bytes]));
            reply.header('Cache-Control', 'public, no-cache, must-revalidate').header('ETag', etag).type(delivery.picture.mimeType);
            if (matchesPublicProfileEtag(request.headers['if-none-match'], etag)) return reply.code(304).send();
            return reply.send(delivery.picture.bytes);
        } catch { return reply.header('Cache-Control', 'no-store').code(503).send({ kind: 'unavailable' }); }
    });
    app.get('/@:handle', { schema: { params: z.strictObject({ handle: z.string() }) } }, async (request, reply) => {
        reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer')
            .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'");
        try {
            const result = await readPublicProfile(request.params.handle, await readRequestHomeEnv(request), deps);
            reply.header('X-Robots-Tag', result.kind === 'published' && result.view.indexable ? 'index, follow' : 'noindex, nofollow');
            const body = renderPublicProfileHtml(result);
            reply.header('Cache-Control', 'public, no-cache, must-revalidate').type('text/html; charset=utf-8');
            if (result.kind === 'unavailable') return reply.code(404).send(body);
            const etag = publicProfileRepresentationEtag(body);
            reply.header('ETag', etag);
            if (matchesPublicProfileEtag(request.headers['if-none-match'], etag)) return reply.code(304).send();
            return reply.send(body);
        } catch {
            return reply.header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex, nofollow')
                .type('text/html; charset=utf-8').code(503).send(renderPublicProfileHtml({ kind: 'unavailable' }));
        }
    });
    app.get('/v1/public/profiles/:handle', { schema: { params: z.strictObject({ handle: z.string() }),
        response: { 200: PublicProfileReadResultV1Schema, 304: z.optional(z.null()), 404: PublicProfileReadResultV1Schema, 503: PublicProfileReadResultV1Schema } } }, async (request, reply) => {
        reply.header('X-Content-Type-Options', 'nosniff').header('X-Robots-Tag', 'noindex').header('Referrer-Policy', 'no-referrer');
        try {
            const result = await readPublicProfile(request.params.handle, await readRequestHomeEnv(request), deps);
            reply.header('Cache-Control', 'public, no-cache, must-revalidate');
            if (result.kind === 'unavailable') return reply.code(404).send(result);
            const etag = publicProfileRepresentationEtag(JSON.stringify(result));
            reply.header('ETag', etag);
            if (matchesPublicProfileEtag(request.headers['if-none-match'], etag)) return reply.code(304).send(undefined);
            return reply.send(result);
        } catch {
            return reply.header('Cache-Control', 'no-store').code(503).send({ kind: 'unavailable' });
        }
    });
}

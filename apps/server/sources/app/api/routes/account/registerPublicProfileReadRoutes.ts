import type { Fastify } from '../../types';
import { createHash } from 'node:crypto';
import { z } from 'zod/mini';
import { PublicProfileReadResultV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { readRequestHomeEnv } from '@/app/home/settings/requestHomeEnv';
import { readPublicProfile } from '@/app/account/profile/publicProfileRead';
import type { PublicProfileServerDependencies } from '@/app/account/profile/publicProfileStorage';
import { publicProfileServerDependencies } from '@/app/account/profile/publicProfileDependencies';

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
    app.get('/v1/public/profiles/:handle', { schema: { params: z.strictObject({ handle: z.string() }),
        response: { 200: PublicProfileReadResultV1Schema, 304: z.optional(z.null()), 404: PublicProfileReadResultV1Schema, 503: PublicProfileReadResultV1Schema } } }, async (request, reply) => {
        reply.header('X-Content-Type-Options', 'nosniff').header('X-Robots-Tag', 'noindex').header('Referrer-Policy', 'no-referrer');
        const exposed = reply.getHeader('Access-Control-Expose-Headers');
        reply.header('Access-Control-Expose-Headers', [exposed, 'ETag'].filter(Boolean).join(', '));
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

import type { Fastify } from '@/app/api/types';
import { normalizeLocalServiceHostOriginBaseDomain } from '@/app/local/services/preview/origin';

export const LOCAL_SERVICE_APPLICATION_HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

/** One isolated-origin data plane for private previews and public exposures. */
export function registerLocalServiceHostRoutes(
    app: Fastify,
    baseDomain: string | null | undefined,
    handler: (request: unknown, reply: unknown) => Promise<unknown>,
): void {
    const domain = baseDomain ? normalizeLocalServiceHostOriginBaseDomain(baseDomain) : null;
    if (!domain) return;
    const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const host = new RegExp(`^[^.]+\\.${escaped}(?::\\d+)?$`, 'iu');
    app.register(async dataPlane => {
        dataPlane.removeContentTypeParser(['application/json', 'text/plain', '*']);
        dataPlane.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
        for (const method of LOCAL_SERVICE_APPLICATION_HTTP_METHODS) {
            // The explicit root wins over the unconstrained static UI root.
            for (const path of ['/', '/*']) {
                if (method === 'GET') {
                    dataPlane.get(path, { exposeHeadRoute: false, constraints: { host } }, handler);
                } else {
                    dataPlane[method.toLowerCase() as Lowercase<typeof method>](path, { constraints: { host } }, handler);
                }
            }
        }
    });
}

import { z } from 'zod/mini';
import { SessionManagerSetRequestV1Schema, SessionManagerSetResultV1Schema, SessionManagerOptionsRequestV1Schema, SessionManagerOptionsV1Schema } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { readSessionAccessAuthenticationFromRequest } from '@/app/session/access/sessionAccessAuthentication';
import { setSessionManager, getSessionManagerOptions } from '@/app/session/follow/sessionManagerService';
import { AccountRouteAuthenticationForbiddenResponseSchema } from '@/app/api/utils/enableAuthentication';
import type { Fastify } from '../../types';

const paramsSchema = z.strictObject({ sessionId: z.string().check(z.minLength(1)) });

/** The resource and every Action delegate authority/CAS/cycles to one transactional owner. */
export function registerSessionManagerRoutes(app: Fastify): void {
    app.post('/v1/sessions/:sessionId/manager/options', {
        preHandler: app.authenticate,
        schema: { params: paramsSchema, body: SessionManagerOptionsRequestV1Schema,
            response: { 200: SessionManagerOptionsV1Schema } },
    }, async (request) => getSessionManagerOptions({
        accountId: request.userId, sessionId: request.params.sessionId,
        ...request.body, authentication: readSessionAccessAuthenticationFromRequest(request),
    }));
    app.post('/v1/sessions/:sessionId/manager', {
        preHandler: app.authenticate,
        config: { apiTokenSessionAction: 'session.manager.set', restrictedCredentialBinding: {
            scope: 'session', session: 'params.sessionId', allowSessionRuntime: false,
            additionalSessions: [{ field: 'body.managerSessionId', nullable: true },
                { field: 'body.expectedManagerSessionId', nullable: true }],
        } },
        schema: {
            params: paramsSchema,
            body: SessionManagerSetRequestV1Schema,
            response: { 200: SessionManagerSetResultV1Schema, 400: SessionManagerSetResultV1Schema,
                403: z.union([SessionManagerSetResultV1Schema, AccountRouteAuthenticationForbiddenResponseSchema]),
                409: SessionManagerSetResultV1Schema },
        },
    }, async (request, reply) => {
        const result = await setSessionManager({
            accountId: request.userId, sessionId: request.params.sessionId,
            ...request.body, authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        const status = result.ok ? 200 : result.error === 'manager_cas_conflict' ? 409 : result.error === 'manager_cycle' ? 400 : 403;
        return reply.code(status).send(result);
    });
}

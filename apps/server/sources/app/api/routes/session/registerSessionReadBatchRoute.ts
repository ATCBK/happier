import {
    SessionReadBatchRequestV1Schema,
    SessionReadBatchResponseV1Schema,
    SessionReadBatchDetailV1Schema,
    SessionReadBatchTurnsV1Schema,
    SessionReadBatchMessagesV1Schema,
    type SessionReadBatchResultV1,
} from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';

import type { Fastify } from '../../types';
import { readSessionAccessAuthenticationFromRequest } from '@/app/session/access/sessionAccessAuthentication';
import { readAccountStoredContentCompatibilityForHttpRequest } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { projectSessionTurnWaitingCompatibility } from '@/app/clientCompatibility/sessionTurnWaitingCompatibility';
import { readDatabaseErrorCode } from '@/app/api/utils/enableErrorHandlers';
import { resolveApiHotEndpointRateLimit } from '@/app/api/utils/apiRateLimitCatalog';
import { logUnexpectedRequestError } from '@/app/api/utils/logUnexpectedRequestError';
import { readSessionDetail } from './registerSessionListingRoutes';
import { readSessionMessagePage } from './registerSessionMessageRoutes';
import { readSessionTurns } from './registerSessionTurnMutationRoute';

/** Batches transport only; each component keeps its existing read and fresh admission owner. */
export function registerSessionReadBatchRoute(app: Fastify) {
    app.post('/v2/sessions/read-batch', {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'session.detail') },
        schema: { body: SessionReadBatchRequestV1Schema, response: { 200: SessionReadBatchResponseV1Schema } },
    }, async (request, reply) => {
        const authentication = readSessionAccessAuthenticationFromRequest(request);
        const storedContentCompatibility = readAccountStoredContentCompatibilityForHttpRequest(request);
        const readComponent = async <T>(read: () => Promise<T>) => {
            try {
                return await read();
            } catch (error) {
                const databaseError = readDatabaseErrorCode(error);
                if (!databaseError) logUnexpectedRequestError(error, { module: 'fastify-error', httpRequestId: request.id });
                return { status: 503 as const, body: { error: databaseError ?? 'session_read_unavailable' } };
            }
        };
        const results = await Promise.all(request.body.sessionIds.map(async sessionId => {
            const input = { userId: request.userId, sessionId, authentication };
            const result: SessionReadBatchResultV1 = { sessionId };
            if (request.body.includeSnapshot) {
                result.detail = await readComponent(async () => {
                    const detail = await readSessionDetail({ ...input, accessProjectionVersion: request.body.accessProjectionVersion, storedContentCompatibility });
                    return SessionReadBatchDetailV1Schema.parse({ ...detail,
                        body: projectSessionTurnWaitingCompatibility(detail.body, storedContentCompatibility) });
                });
                if (result.detail.status === 200) {
                    result.turns = await readComponent(async () => {
                        const turns = await readSessionTurns(input);
                        return SessionReadBatchTurnsV1Schema.parse({ ...turns,
                            body: projectSessionTurnWaitingCompatibility(turns.body, storedContentCompatibility) });
                    });
                }
            }
            if (request.body.includeMessages) {
                result.messages = await readComponent(async () => {
                    const messages = await readSessionMessagePage({ ...input,
                        query: { scope: 'all', roles: 'user,agent,event' }, previewRequest: request });
                    return SessionReadBatchMessagesV1Schema.parse({ ...messages,
                        body: projectSessionTurnWaitingCompatibility(messages.body, storedContentCompatibility) });
                });
            }
            return result;
        }));
        return reply.header('Cache-Control', 'no-store').send({ results });
    });
}

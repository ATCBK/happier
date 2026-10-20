import { SessionListQueryResponseV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { SessionListQueryV1Schema, SessionListUnavailableQueryV1Schema } from '@happier-dev/protocol/sessions/listing/query';
import { z } from 'zod/mini';
import { projectSessionTurnWaitingHttpResponse } from '@/app/clientCompatibility/sessionTurnWaitingCompatibility';

import { resolveApiHotEndpointRateLimit } from '@/app/api/utils/apiRateLimitCatalog';
import { readAccountStoredContentCompatibilityForHttpRequest } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { createServerFeatureGatePreHandler } from '@/app/features/catalog/serverFeatureGate';
import {
    createSessionMetadataListRepresentabilityWhere,
    createSessionMetadataPrivacyUpgradeRequiredResponse,
    isSessionMetadataPrivacyUpgradeRequiredError,
} from '@/app/session/metadata/sessionMetadataRecipientProjection';
import {
    listSessionsForAccount,
    SessionListInvalidCursorError,
    SessionListUnavailableQueryError,
} from '@/app/session/listing/service';
import { createV2SessionListServerTiming } from '@/app/session/listing/timing';
import { type Fastify } from '../../types';
import { readSessionAccessAuthenticationFromRequest } from '@/app/session/access/sessionAccessAuthentication';

const FILTERED_LISTING_UNAVAILABLE_RESPONSE_SCHEMA = z.union([
    z.strictObject({ error: z.literal('not_found') }),
    SessionListUnavailableQueryV1Schema,
]);
const FILTERED_LISTING_METADATA_UPGRADE_RESPONSE_SCHEMA = z.strictObject({
    error: z.literal('Session metadata privacy upgrade required'),
    code: z.literal('metadata_privacy_upgrade_required'),
});
const FILTERED_LISTING_INVALID_CURSOR_RESPONSE_SCHEMA = z.strictObject({
    error: z.literal('Invalid cursor format'),
});

/** The route stays unavailable until the canonical feature catalog enables it. */
export function registerSessionFilteredListingRoute(app: Fastify): void {
    app.post('/v2/sessions/query', {
        preSerialization: projectSessionTurnWaitingHttpResponse,
        preHandler: [
            createServerFeatureGatePreHandler('sessions.filteredListing'),
            app.authenticate,
        ],
        schema: {
            body: SessionListQueryV1Schema,
            response: {
                200: SessionListQueryResponseV1Schema,
                400: FILTERED_LISTING_INVALID_CURSOR_RESPONSE_SCHEMA,
                404: FILTERED_LISTING_UNAVAILABLE_RESPONSE_SCHEMA,
                409: FILTERED_LISTING_METADATA_UPGRADE_RESPONSE_SCHEMA,
            },
        },
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, 'sessions.list'),
        },
    }, async (request, reply) => {
        const timing = createV2SessionListServerTiming(request);
        try {
            const payload = await listSessionsForAccount({
                userId: request.userId,
                authentication: readSessionAccessAuthenticationFromRequest(request),
                source: { kind: 'query', query: request.body },
                timing,
                rowRepresentabilityWhere: createSessionMetadataListRepresentabilityWhere(
                    readAccountStoredContentCompatibilityForHttpRequest(request),
                ),
            });
            if (!payload) return;
            timing.apply(reply);
            return reply.send(SessionListQueryResponseV1Schema.parse(payload));
        } catch (error) {
            if (error instanceof SessionListInvalidCursorError) {
                return reply.code(400).send({ error: 'Invalid cursor format' });
            }
            if (error instanceof SessionListUnavailableQueryError) {
                return reply.code(404).send({
                    error: 'not_found',
                    code: 'filtered_session_listing_unavailable',
                    reason: error.reason,
                });
            }
            if (isSessionMetadataPrivacyUpgradeRequiredError(error)) {
                return reply.code(409).send(createSessionMetadataPrivacyUpgradeRequiredResponse());
            }
            throw error;
        }
    });
}

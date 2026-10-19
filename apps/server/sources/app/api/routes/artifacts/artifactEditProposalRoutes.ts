import { z } from 'zod/mini';
import * as privacyKit from 'privacy-kit';
import { DOC_EDIT_PROPOSAL_HTTP_PATHS_V1, DocEditAcceptTransportInputV1Schema, DocEditDeclineTransportInputV1Schema,
    DocEditDecisionResultV1Schema } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { decideArtifactEditProposal, type ArtifactEditProposalDecisionResult } from '@/app/artifacts/artifactEditProposalService';
import { createServerFeatureGatedRouteApp } from '@/app/features/catalog/serverFeatureGate';
import { readSessionAccessAuthenticationFromRequest } from '@/app/session/access/sessionAccessAuthentication';
import { requirePresentUser } from '@/app/api/utils/requirePresentUser';
import { resolveApiHotEndpointRateLimit } from '@/app/api/utils/apiRateLimitCatalog';
import { eventRouter, buildUpdateArtifactUpdate } from '@/app/events/eventRouter';
import { randomKeyNaked } from '@/utils/keys/randomKeyNaked';
import type { Fastify } from '../../types';

const FailureSchema = z.strictObject({ error: z.string() });
const responses = { 200: DocEditDecisionResultV1Schema, 400: FailureSchema, 403: FailureSchema, 404: FailureSchema,
    409: FailureSchema, 413: FailureSchema } as const;

function failureStatus(error: string) {
    if (error === 'doc_edit_proposal_present_person_required' || error === 'doc_edit_proposal_edit_access_required'
        || error === 'discussion_access_forbidden' || error === 'discussion_manage_denied') return 403 as const;
    if (error === 'artifact_not_found' || error === 'not-found' || error === 'discussion_not_found' || error === 'discussion_read_denied') return 404 as const;
    if (error === 'quota_exceeded') return 413 as const;
    if (error === 'version-mismatch' || error === 'artifact_content_unavailable' || error === 'discussion_content_unavailable'
        || error === 'doc_edit_proposal_disposition_unavailable' || error === 'doc_edit_proposal_preparation_required'
        || error === 'doc_edit_proposal_encrypted_preparation_unavailable') return 409 as const;
    return 400 as const;
}

/** Fresh acceptance publishes the incumbent Artifact update only after the service transaction commits. */
function publishAcceptedArtifact(result: Extract<ArtifactEditProposalDecisionResult, { ok: true }>, artifactId: string | undefined) {
    const updated = result.artifactUpdate;
    if (!updated?.body || !artifactId) return;
    for (const recipient of updated.recipientUpdates) {
        eventRouter.emitUpdate({ userId: recipient.accountId,
            payload: buildUpdateArtifactUpdate(artifactId, recipient.cursor.resolveCursor(), randomKeyNaked(12), undefined,
                { value: privacyKit.encodeBase64(new Uint8Array(updated.body.bytes)), version: updated.body.version }, recipient),
            recipientFilter: { type: 'user-scoped-only' } });
    }
}

/** Transport supplies authenticated person evidence; the single service owns access, CAS and disposition. */
export function registerArtifactEditProposalRoutes(app: Fastify) {
    const scoped = createServerFeatureGatedRouteApp(app, 'sessions.conversations', process.env, { error: 'discussions_unavailable' });
    const preHandler = [app.authenticate, requirePresentUser];
    const config = { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'artifacts') };
    scoped.post(DOC_EDIT_PROPOSAL_HTTP_PATHS_V1.accept, {
        preHandler, config, schema: { body: DocEditAcceptTransportInputV1Schema, response: responses },
    }, async (request, reply) => {
        const result = await decideArtifactEditProposal({ actorAccountId: request.userId,
            authentication: readSessionAccessAuthenticationFromRequest(request), decision: 'accept', ...request.body });
        if (!result.ok) return reply.code(failureStatus(result.error)).send({ error: result.error });
        publishAcceptedArtifact(result, result.artifactId);
        return reply.send({ proposalRef: request.body.proposalRef, docEditProposalDispositionV1: result.disposition });
    });
    scoped.post(DOC_EDIT_PROPOSAL_HTTP_PATHS_V1.decline, {
        preHandler, config, schema: { body: DocEditDeclineTransportInputV1Schema, response: responses },
    }, async (request, reply) => {
        const result = await decideArtifactEditProposal({ actorAccountId: request.userId,
            authentication: readSessionAccessAuthenticationFromRequest(request), decision: 'decline', ...request.body });
        if (!result.ok) return reply.code(failureStatus(result.error)).send({ error: result.error });
        return reply.send({ proposalRef: request.body.proposalRef, docEditProposalDispositionV1: result.disposition });
    });
}

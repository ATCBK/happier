import { z } from 'zod/mini';
import { extend, omit } from 'zod/mini';
import {
    ProjectSourcesListInputV1Schema, ProjectSourcesListOutputV1Schema,
    ProjectSourcesReadInputV1Schema, ProjectSourcesReadOutputV1Schema,
    ProjectSourcesCreateInputV1Schema, ProjectSourcesCreateOutputV1Schema,
    ProjectSourcesUpdateInputV1Schema, ProjectSourcesUpdateOutputV1Schema,
    ProjectSourcesDeleteInputV1Schema, ProjectSourcesDeleteOutputV1Schema,
    ProjectSourcesFailureV1Schema,
} from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { inReadSnapshot, inTx } from '@/storage/inTx';
import { readTeamOperationAuthenticationFromRequest } from '@/app/teams/actorContext';
import { createProjectSourceInTx, readProjectSourceInTx, listProjectSourcesInTx, updateProjectSourceInTx, deleteProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import type { Fastify } from '../../types';

const params = z.strictObject({ id: z.string().check(z.minLength(1)) });
function resultStatus(result: { ok: boolean; error?: 'source_invalid' | 'source_unavailable' }): 200 | 400 | 404;
function resultStatus(result: { ok: boolean; error?: 'source_invalid' | 'source_unavailable' | 'source_access_denied' | 'source_conflict' }): 200 | 400 | 403 | 404 | 409;
function resultStatus(result: { ok: boolean; error?: string }): 200 | 400 | 403 | 404 | 409 | 503;
function resultStatus(result: { ok: boolean; error?: string }): 200 | 400 | 403 | 404 | 409 | 503 {
    return result.ok ? 200
    : result.error === 'source_conflict' ? 409
    : result.error === 'source_access_denied' ? 403
    : result.error === 'source_unavailable' ? 404
    : result.error === 'artifact_unavailable' || result.error === 'source_backend_unavailable' ? 503 : 400;
}

/** Metadata-only front doors share one admission, membership and CAS owner. */
export function projectSourceRoutes(app: Fastify): void {
    const readResponse = { 200: ProjectSourcesReadOutputV1Schema, 400: ProjectSourcesReadOutputV1Schema, 403: ProjectSourcesReadOutputV1Schema, 404: ProjectSourcesReadOutputV1Schema, 409: ProjectSourcesFailureV1Schema, 503: ProjectSourcesFailureV1Schema };
    app.get('/v1/projects/sources', { preHandler: app.authenticate, config: { allowApiToken: true }, attachValidation: true, schema: {
        querystring: extend(omit(ProjectSourcesListInputV1Schema, { audience: true, limit: true }), { audience: z.optional(z.string()), limit: z.optional(z.coerce.number().check(z.int(), z.positive())) }),
        response: { 200: ProjectSourcesListOutputV1Schema, 400: ProjectSourcesListOutputV1Schema, 403: ProjectSourcesListOutputV1Schema, 404: ProjectSourcesListOutputV1Schema, 409: ProjectSourcesFailureV1Schema, 503: ProjectSourcesFailureV1Schema },
    } }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send({ ok: false, error: 'source_invalid' });
        let audience: unknown;
        try { audience = request.query.audience === undefined ? undefined : JSON.parse(request.query.audience); }
        catch { return reply.code(400).send({ ok: false, error: 'source_invalid' }); }
        const result = await inReadSnapshot(tx => listProjectSourcesInTx(tx, request.userId, { ...request.query, audience }, readTeamOperationAuthenticationFromRequest(request)));
        return reply.code(resultStatus(result)).send(result);
    });
    app.get('/v1/projects/sources/:id', { preHandler: app.authenticate, config: { allowApiToken: true }, attachValidation: true, schema: {
        params, querystring: omit(ProjectSourcesReadInputV1Schema, { sourceId: true }), response: readResponse,
    } }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send({ ok: false, error: 'source_invalid' });
        const result = await inReadSnapshot(tx => readProjectSourceInTx(tx, request.userId, { serverId: request.query.serverId, sourceId: request.params.id }, readTeamOperationAuthenticationFromRequest(request)));
        return reply.code(resultStatus(result)).send(result);
    });
    app.post('/v1/projects/sources', { preHandler: app.authenticate, config: { allowApiToken: true }, attachValidation: true, schema: {
        body: ProjectSourcesCreateInputV1Schema, response: { ...readResponse, 200: ProjectSourcesCreateOutputV1Schema, 409: ProjectSourcesCreateOutputV1Schema },
    } }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send({ ok: false, error: 'source_invalid' });
        const result = await inTx(tx => createProjectSourceInTx(tx, request.userId, request.body, readTeamOperationAuthenticationFromRequest(request)), { /* Project source replay and Team/audience/Artifact admission span independent rows. */ isolationLevel: "Serializable" });
        return reply.code(resultStatus(result)).send(result);
    });
    app.patch('/v1/projects/sources/:id', { preHandler: app.authenticate, config: { allowApiToken: true }, attachValidation: true, schema: {
        params, body: ProjectSourcesUpdateInputV1Schema, response: { ...readResponse, 409: ProjectSourcesUpdateOutputV1Schema, 503: ProjectSourcesUpdateOutputV1Schema },
    } }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send({ ok: false, error: 'source_invalid' });
        if (request.body.sourceId !== request.params.id) return reply.code(400).send({ ok: false, error: 'source_invalid' });
        const result = await inTx(tx => updateProjectSourceInTx(tx, request.userId, request.body, readTeamOperationAuthenticationFromRequest(request)), { /* Project source replay and Team/audience/Artifact admission span independent rows. */ isolationLevel: "Serializable" });
        return reply.code(resultStatus(result)).send(result);
    });
    app.delete('/v1/projects/sources/:id', { preHandler: app.authenticate, config: { allowApiToken: true }, attachValidation: true, schema: {
        params, body: ProjectSourcesDeleteInputV1Schema, response: {
            200: ProjectSourcesDeleteOutputV1Schema, 400: ProjectSourcesDeleteOutputV1Schema,
            403: ProjectSourcesDeleteOutputV1Schema, 404: ProjectSourcesDeleteOutputV1Schema, 409: ProjectSourcesDeleteOutputV1Schema,
            503: ProjectSourcesFailureV1Schema,
        },
    } }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send({ ok: false, error: 'source_invalid' });
        if (request.body.sourceId !== request.params.id) return reply.code(400).send({ ok: false, error: 'source_invalid' });
        const result = await inTx(tx => deleteProjectSourceInTx(tx, request.userId, request.body, readTeamOperationAuthenticationFromRequest(request)), { /* Project source replay and Team/audience/Artifact admission span independent rows. */ isolationLevel: "Serializable" });
        return reply.code(resultStatus(result)).send(result);
    });
}

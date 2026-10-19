import type { Fastify } from '@/app/api/types';
import { z } from 'zod/mini';
import {
    PROJECT_ACCOUNT_ROWS_ROUTE_V1,
    ProjectAccountRowReadRequestV1Schema, ProjectAccountRowReadResponseV1Schema,
    ProjectAccountRowListRequestV1Schema, ProjectAccountRowListResponseV1Schema,
    ProjectAccountRowMutationRequestV1Schema, ProjectAccountRowMutationResponseV1Schema,
} from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { asServerProtocolZod } from '@/app/api/utils/protocolComposableZodAdapter';
import { resolveApiHotEndpointRateLimit } from '@/app/api/utils/apiRateLimitCatalog';
import { listProjectAccountRowsInTx, mutateProjectAccountRows, readProjectAccountRowInTx } from '@/app/projects/projectAccountRowService';
import { inTx } from '@/storage/inTx';

/** All private rows use the authenticated Account, never a caller-supplied owner. */
export function registerProjectAccountRowRoutes(app: Fastify): void {
    const config = { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'account.settings') };
    const errors = { 400: z.strictObject({ error: z.literal('invalid-params') }), 500: z.strictObject({ error: z.literal('internal') }) };
    app.post(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`, {
        preHandler: app.authenticate, config,
        schema: { body: asServerProtocolZod(ProjectAccountRowReadRequestV1Schema), response: { 200: asServerProtocolZod(ProjectAccountRowReadResponseV1Schema), ...errors } },
    }, async (request, reply) => {
        try { return reply.send(await inTx(tx => readProjectAccountRowInTx(tx, { accountId: request.userId, key: request.body.key }), { /* Account mode and catalog content must share one capture. */ isolationLevel: "Serializable", readOnly: true })); }
        catch { return reply.code(500).send({ error: 'internal' }); }
    });
    app.post(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, {
        preHandler: app.authenticate, config,
        schema: { body: asServerProtocolZod(ProjectAccountRowListRequestV1Schema), response: { 200: asServerProtocolZod(ProjectAccountRowListResponseV1Schema), ...errors } },
    }, async (request, reply) => {
        try { return reply.send(await inTx(tx => listProjectAccountRowsInTx(tx, { accountId: request.userId, ...request.body }), { /* Account mode and catalog content must share one capture. */ isolationLevel: "Serializable", readOnly: true })); }
        catch { return reply.code(500).send({ error: 'internal' }); }
    });
    app.post(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/mutate`, {
        preHandler: app.authenticate, config,
        schema: { body: asServerProtocolZod(ProjectAccountRowMutationRequestV1Schema), response: { 200: asServerProtocolZod(ProjectAccountRowMutationResponseV1Schema), ...errors } },
    }, async (request, reply) => {
        try { return reply.send(await mutateProjectAccountRows({ accountId: request.userId, request: request.body })); }
        catch { return reply.code(500).send({ error: 'internal' }); }
    });
}

import { z } from 'zod/mini';
import {
    CONNECTED_PRESENTATION_ROWS_ROUTE_V1,
    CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1,
    ConnectedPresentationRowReadResponseV1Schema,
    ConnectedAcknowledgementsRowReadResponseV1Schema,
    ConnectedPresentationRowMutationV1Schema,
    ConnectedAcknowledgementsRowMutationV1Schema,
    ConnectedMetadataRowMutationResponseV1Schema,
} from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import type { Fastify } from '@/app/api/types';
import { asServerProtocolZod } from '@/app/api/utils/protocolComposableZodAdapter';
import { resolveApiHotEndpointRateLimit } from '@/app/api/utils/apiRateLimitCatalog';
import { inReadSnapshot, inTx } from '@/storage/inTx';
import { readReservedAccountScopedKvRowMutationConflict } from '@/app/kv/reservedAccountScopedKvRow';
import {
    readConnectedPresentationRowInTx,
    readConnectedAcknowledgementsRowInTx,
    mutateConnectedPresentationRowInTx,
    mutateConnectedAcknowledgementsRowInTx,
} from './presentationRows';

const internal = z.strictObject({ error: z.literal('internal') });

/** Singleton catalogs are addressed solely by the authenticated Account, never an external key or Account id. */
export function registerConnectedMetadataRoutes(app: Fastify): void {
    const config = { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'account.settings') };
    app.get(CONNECTED_PRESENTATION_ROWS_ROUTE_V1, { preHandler: app.authenticate, config,
        schema: { response: { 200: asServerProtocolZod(ConnectedPresentationRowReadResponseV1Schema), 500: internal } },
    }, async (request, reply) => {
        try { return reply.send(await inReadSnapshot(tx => readConnectedPresentationRowInTx(tx, { accountId: request.userId }))); }
        catch { return reply.code(500).send({ error: 'internal' }); }
    });
    app.get(CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1, { preHandler: app.authenticate, config,
        schema: { response: { 200: asServerProtocolZod(ConnectedAcknowledgementsRowReadResponseV1Schema), 500: internal } },
    }, async (request, reply) => {
        try { return reply.send(await inReadSnapshot(tx => readConnectedAcknowledgementsRowInTx(tx, { accountId: request.userId }))); }
        catch { return reply.code(500).send({ error: 'internal' }); }
    });
    app.post(CONNECTED_PRESENTATION_ROWS_ROUTE_V1, { preHandler: app.authenticate, config,
        schema: { body: asServerProtocolZod(ConnectedPresentationRowMutationV1Schema),
            response: { 200: asServerProtocolZod(ConnectedMetadataRowMutationResponseV1Schema), 500: internal } },
    }, async (request, reply) => {
        try { return reply.send(await inTx(tx => mutateConnectedPresentationRowInTx(tx, { ...request.body, accountId: request.userId }))); }
        catch (error) {
            const conflict = await readReservedAccountScopedKvRowMutationConflict(error);
            return conflict ? reply.send(conflict) : reply.code(500).send({ error: 'internal' });
        }
    });
    app.post(CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1, { preHandler: app.authenticate, config,
        schema: { body: asServerProtocolZod(ConnectedAcknowledgementsRowMutationV1Schema),
            response: { 200: asServerProtocolZod(ConnectedMetadataRowMutationResponseV1Schema), 500: internal } },
    }, async (request, reply) => {
        try { return reply.send(await inTx(tx => mutateConnectedAcknowledgementsRowInTx(tx, { ...request.body, accountId: request.userId }))); }
        catch (error) {
            const conflict = await readReservedAccountScopedKvRowMutationConflict(error);
            return conflict ? reply.send(conflict) : reply.code(500).send({ error: 'internal' });
        }
    });
}

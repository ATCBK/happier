import {
    MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogRowReadResponseV1Schema,
    McpServerCatalogRowMutationV1Schema, McpServerCatalogRowMutationResponseV1Schema,
} from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import type { Fastify } from '@/app/api/types';
import { asServerProtocolZod } from '@/app/api/utils/protocolComposableZodAdapter';
import { resolveApiHotEndpointRateLimit } from '@/app/api/utils/apiRateLimitCatalog';
import { readTeamOperationAuthenticationFromRequest } from '@/app/teams/actorContext';
import { inReadSnapshot, inTx } from '@/storage/inTx';
import { mutateMcpServerCatalogRowInTx, readMcpServerCatalogRowInTx } from './serverRows';
import { readReservedAccountScopedKvRowMutationConflict } from '@/app/kv/reservedAccountScopedKvRow';
import { AccountSettingsPublicationConflict } from '@/app/accountSettings/writeAccountSettingsInTx';

/** Authenticated Account identity, never a caller-supplied Account or arbitrary KV key. */
export function registerMcpServerCatalogRoutes(app: Fastify): void {
    const config = { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'account.settings') };
    app.get(MCP_SERVER_CATALOG_ROWS_ROUTE_V1, { preHandler: app.authenticate, config,
        schema: { response: { 200: asServerProtocolZod(McpServerCatalogRowReadResponseV1Schema) } },
    }, async (request, reply) => {
        return reply.send(await inReadSnapshot(tx => readMcpServerCatalogRowInTx(tx, { accountId: request.userId }), {
            /* Account mode and catalog content must share one capture. */
            transactionClass: 'mcp-catalog-read',
        }));
    });
    app.post(MCP_SERVER_CATALOG_ROWS_ROUTE_V1, { preHandler: app.authenticate, config,
        schema: { body: asServerProtocolZod(McpServerCatalogRowMutationV1Schema),
            response: { 200: asServerProtocolZod(McpServerCatalogRowMutationResponseV1Schema) } },
    }, async (request, reply) => {
        try { return reply.send(await inTx(tx => mutateMcpServerCatalogRowInTx(tx, {
            accountId: request.userId, ...request.body, authentication: readTeamOperationAuthenticationFromRequest(request),
        }), {
            /* The domain takes the Account transition fence before its reads.
             * ReadCommitted sees the winning Account after a publication-lock wait;
             * Serializable instead retries a snapshot invalidated by every cursor write. */
            transactionClass: 'mcp-catalog-mutate',
        })); }
        catch (error) {
            const conflict = await readReservedAccountScopedKvRowMutationConflict(error);
            if (conflict) return reply.send(conflict);
            if (error instanceof AccountSettingsPublicationConflict) return reply.send(error.result.status === 'version_mismatch'
                ? { status: 'settings-conflict', revision: error.result.currentVersion } : { status: 'invalid-stored-content' });
            throw error;
        }
    });
}

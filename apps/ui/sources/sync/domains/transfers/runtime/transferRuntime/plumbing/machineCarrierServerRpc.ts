import { DIRECT_TRANSFER_SESSION_EXPIRES_AT_HEADER } from '@happier-dev/protocol/machines/transfer/directPeerUrls';
import {
    PreparedTransferRpcRequestV1Schema,
    PreparedTransferRpcResponseV1Schema,
    resolvePreparedTransferRpcPhaseV1,
} from '@happier-dev/protocol/machines/transfer/preparedTransferRpcV1';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { encodeBase64 } from '@/encryption/base64';
import type { MachineCarrierHttpRequester } from './machineCarrierHttpLease';

/** The Home transports the same prepared capability and encrypted HTTP phase bodies. */
export function createMachineCarrierServerRpcRequester(input: Readonly<{
    machineId: string;
    serverId: string;
    operationId: string;
    accountLifetime?: ServerAccountScopeLifetime;
}>): MachineCarrierHttpRequester {
    return async (resource, init) => {
        if (resource instanceof Request) throw new Error('Prepared transfer requests require an explicit phase');
        const url = new URL(String(resource));
        const httpMethod = init?.method?.toUpperCase() ?? 'GET';
        const body: unknown = typeof init?.body === 'string' && init.body.length > 0 ? JSON.parse(init.body) : undefined;
        const method = resolvePreparedTransferRpcPhaseV1(url.pathname, httpMethod, body);
        const importing = url.pathname.includes('/imports/');
        const encodedId = url.pathname.split('/')[importing ? 4 : 3];
        const expectedId = importing ? encodeURIComponent(input.operationId) : encodeBase64(new TextEncoder().encode(input.operationId), 'base64url');
        if (!method || !encodedId || encodedId !== expectedId || url.search || url.hash) {
            throw new Error('Prepared transfer phase does not match its capability');
        }
        const headers = new Headers(init?.headers);
        const authorization = headers.get('authorization');
        const authorizationToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
        const recipient = headers.get('x-happier-transfer-recipient-public-key');
        if (init?.body !== undefined && init.body !== null && typeof init.body !== 'string') {
            throw new Error('Prepared transfer phase requires a JSON body');
        }
        const payload = PreparedTransferRpcRequestV1Schema.parse({
            t: 'prepared_machine_transfer_v1', path: url.pathname, httpMethod,
            ...(authorizationToken ? { authorizationToken } : {}),
            ...(recipient ? { recipientPublicKeyBase64: recipient } : {}),
            ...(body !== undefined ? { body } : {}),
        });
        init?.signal?.throwIfAborted();
        if (input.accountLifetime && !input.accountLifetime.isCurrent()) throw new Error('action_account_scope_changed');
        const response = PreparedTransferRpcResponseV1Schema.parse(await machineRpcWithServerScope({
            machineId: input.machineId, serverId: input.serverId,
            accountId: input.accountLifetime?.scope.accountId,
            method, payload, preferScoped: true,
            ...(init?.signal ? { signal: init.signal } : {}),
        }));
        if (input.accountLifetime && !input.accountLifetime.isCurrent()) throw new Error('action_account_scope_changed');
        return new Response(response.body, { status: response.status, headers: {
            ...(response.contentType ? { 'content-type': response.contentType } : {}),
            ...(response.sessionExpiresAt ? { [DIRECT_TRANSFER_SESSION_EXPIRES_AT_HEADER]: response.sessionExpiresAt } : {}),
        } });
    };
}
